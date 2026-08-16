import type { Logger, MatterAccessory, MatterAPI } from 'homebridge';
import { HIVE_MAX_TEMP, HIVE_MIN_TEMP, PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { HiveHeatingZone, HiveHotWater, HiveMode, HiveNotReadyError } from './hiveApi';

type MatterApiHost = {
  isMatterEnabled?: () => boolean;
  matter?: MatterAPI;
};

type HiveMatterCommands = {
  setHeatingMode(id: string, mode: HiveMode): Promise<void>;
  setHeatingTarget(id: string, temp: number): Promise<void>;
  setHotWaterBoost(id: string, minutes: number): Promise<void>;
  cancelHotWaterBoost(id: string, previousMode?: HiveMode): Promise<void>;
  pollSoon(): void;
};

type HiveMatterContext = {
  hiveId: string;
  kind: 'heating' | 'hotwater';
};

const CELSIUS_TO_MATTER = 100;

/**
 * The Matter Thermostat features this plugin composes when Homebridge lets it
 * choose (Homebridge >= 2.4.0, via `api.matter.deviceRequirements`).
 *
 * Hive only heats, so Heating is the one we actually want. AutoMode carries the
 * Hive schedule, which HomeKit has no other way to express — and the Matter spec
 * conforms HEAT and COOL as "AUTO, O.a+", meaning AutoMode requires BOTH heating
 * and cooling. Cooling is therefore along for the ride and stays inert:
 * controlSequenceOfOperation is HeatingOnly and the cooling setpoint is pinned
 * to the top of the range (see heatingCluster()).
 *
 * Occupancy is deliberately absent. The old code declared a hardcoded
 * `occupancy: { occupied: true }`, which advertised a capability Hive does not
 * have and is rejected outright once the feature is not composed.
 */
const THERMOSTAT_FEATURES = ['Heating', 'Cooling', 'AutoMode'] as const;

/**
 * How the thermostat endpoint will be built on the running Homebridge.
 *
 * This is NOT a guess — see composeThermostat() for how each regime is detected.
 * Heating/Cooling/AutoMode end up live in every supported regime; the only
 * thing that varies is whether Presets is forced on.
 */
type ThermostatComposition = {
  /** The device type to register, composed by us where that is supported. */
  deviceType: MatterAccessory['deviceType'];
  /** Presets live: a non-empty `presetTypes` array is REQUIRED. */
  presets: boolean;
  /** Human-readable regime, for the startup log. */
  regime: string;
};

export class HiveMatterPlatform {
  private readonly cached = new Map<string, MatterAccessory<HiveMatterContext>>();
  private registered = false;
  /** Resolved once per registration by composeThermostat(). */
  private thermostat?: ThermostatComposition;

  /**
   * Latest hot water state per Hive product id. Matter accessories (and their
   * command handlers) are built once at registration, so a handler that read
   * its captured `hw` would act on a snapshot that goes stale within one poll.
   * Handlers read through here instead.
   */
  private readonly latestHotWater = new Map<string, HiveHotWater>();

  /**
   * Last attribute payload written per accessory UUID, so a poll that produces
   * identical state doesn't queue redundant Matter writes.
   */
  private readonly lastWritten = new Map<string, string>();

  constructor(
    private readonly api: MatterApiHost,
    private readonly log: Logger,
    private readonly commands: HiveMatterCommands,
    private readonly hotWaterBoostMinutes: number,
  ) {}

  get enabled(): boolean {
    return this.api.isMatterEnabled?.() === true && !!this.api.matter;
  }

  configureAccessory(accessory: MatterAccessory<HiveMatterContext>): void {
    this.cached.set(accessory.UUID, accessory);
  }

  async register(state: {
    zones: HiveHeatingZone[];
    hotWater: HiveHotWater[];
  }): Promise<void> {
    if (!this.enabled || this.registered) {
      return;
    }

    const matter = this.api.matter!;

    // Unregister all previously cached accessories before re-registering.
    // After a full Homebridge process restart the cached endpoint objects
    // come from a different Matter.js module instance, causing
    // "identify is not a Behavior.Type" errors when Homebridge tries to
    // reuse them.  Clearing them forces fresh endpoint creation.
    await this.unregisterCached(matter);

    if (state.zones.length === 0 && state.hotWater.length === 0) {
      this.registered = true;
      return;
    }

    this.thermostat = this.composeThermostat(matter);
    this.log.info(
      `Hive: Matter thermostat — ${this.thermostat.regime} ` +
        `(Presets=${this.thermostat.presets}).`,
    );

    await this.registerWith(matter, state);

    // Verification is now a health check rather than a retry trigger: the
    // feature set is derived, not guessed, so a failure here means something
    // genuinely unexpected and is worth a loud, actionable log line. A
    // thermostat that fails validation never enters the live accessory map, so
    // its state stays unreadable.
    if (state.zones.length > 0 && !(await this.verifyThermostats(matter, state))) {
      this.log.error(
        'Hive: thermostat endpoint(s) did not come online. Please open a GitHub ' +
          'issue with the Homebridge log and your Homebridge version.',
      );
    }

    this.registered = true;
  }

  /**
   * Decide the thermostat device type and the feature set that will be live on
   * it. Three Homebridge generations behave differently here, and each is
   * identified by an observable property rather than a version string:
   *
   * • Homebridge >= 2.4.0 — `api.matter.deviceRequirements` exists, so we
   *   compose the cluster ourselves and Homebridge leaves our choice alone
   *   (AccessoryManager skips detection when `behaviors.thermostat` is set).
   *   This is the only regime where we are fully in control.
   *
   * • Homebridge <= 2.2.x — `deviceTypes.Thermostat` arrives pre-composed with
   *   Heating/Cooling/AutoMode/Occupancy. Homebridge then replaces the server
   *   with HomebridgeThermostatServer, and its feature detection was broken
   *   (it read `cluster.supportedFeatures`, which is never populated, so it
   *   always fell back to "no features"). The live endpoint therefore ends up
   *   with matter.js's ThermostatServer defaults — Heating, Cooling, Occupancy,
   *   AutoMode AND Presets — which is why a non-empty `presetTypes` was
   *   mandatory on these builds.
   *
   * • Homebridge 2.3.x — the device type is bare and the detection bug is
   *   fixed, but there is no way to override the detected features. We do not
   *   need one: detectThermostatFeatures() reads the declared setpoints, and
   *   because heatingCluster() always declares a cooling setpoint alongside the
   *   heating one it derives exactly Heating/Cooling/AutoMode — the same set we
   *   compose explicitly above. Presets is never detected, so it stays off.
   */
  private composeThermostat(matter: MatterAPI): ThermostatComposition {
    const base = matter.deviceTypes.Thermostat;

    // Optional at runtime: older Homebridge has no such property.
    const requirements = (matter as Partial<MatterAPI>).deviceRequirements
      ?.Thermostat?.ThermostatServer;
    if (requirements) {
      return {
        deviceType: base.with(requirements.with(...THERMOSTAT_FEATURES)),
        presets: false,
        regime: 'Homebridge >= 2.4.0, features composed by the plugin',
      };
    }

    // A pre-composed device type carries its thermostat behavior; the bare
    // ThermostatDevice that 2.3.x hands out does not.
    if ((base as { behaviors?: Record<string, unknown> }).behaviors?.thermostat) {
      return {
        deviceType: base,
        presets: true,
        regime: 'Homebridge <= 2.2.x, pre-composed device type',
      };
    }

    return {
      deviceType: base,
      presets: false,
      regime: 'Homebridge 2.3.x, features detected from the declared setpoints',
    };
  }

  /** Build and register all accessories using the resolved composition. */
  private async registerWith(
    matter: MatterAPI,
    state: { zones: HiveHeatingZone[]; hotWater: HiveHotWater[] },
  ): Promise<void> {
    const accessories = [
      ...state.zones.map((zone) => this.heatingAccessory(zone)),
      ...state.hotWater.map((hw) => this.hotWaterAccessory(matter, hw)),
    ];
    if (!accessories.length) {
      return;
    }
    await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories);
    for (const accessory of accessories) {
      this.cached.set(accessory.UUID, accessory);
    }
    this.log.info(`Hive: registered ${accessories.length} Matter accessories.`);
  }

  /** Unregister and forget all currently cached accessories. */
  private async unregisterCached(matter: MatterAPI): Promise<void> {
    if (this.cached.size === 0) {
      return;
    }
    const previous = [...this.cached.values()];
    this.cached.clear();
    // Fresh endpoints are created with the cluster values passed at
    // registration, so the change-detection baseline must not survive them.
    this.lastWritten.clear();
    try {
      await matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, previous);
    } catch (err) {
      this.log.debug(
        `Hive: clearing previous Matter accessories: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Poll each heating zone's Matter state until it is readable (endpoint is
   * live) or a short deadline passes. Returns true only when every thermostat
   * came online — a failed endpoint never becomes readable.
   */
  private async verifyThermostats(
    matter: MatterAPI,
    state: { zones: HiveHeatingZone[] },
  ): Promise<boolean> {
    const pending = new Set(state.zones.map((z) => this.heatingUuid(z.id)));
    const deadlineMs = Date.now() + 6000;
    while (pending.size > 0 && Date.now() < deadlineMs) {
      for (const uuid of [...pending]) {
        try {
          const st = await matter.getAccessoryState?.(
            uuid,
            matter.clusterNames.Thermostat,
          );
          if (st && Object.keys(st).length > 0) {
            pending.delete(uuid);
          }
        } catch {
          /* endpoint not ready (or failed) — keep polling until the deadline */
        }
      }
      if (pending.size === 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return pending.size === 0;
  }

  async updateHeating(zone: HiveHeatingZone): Promise<void> {
    if (!this.enabled || !this.registered) {
      return;
    }
    const matter = this.api.matter!;
    // Only push the attributes that actually change at runtime. The setpoint
    // limits and controlSequenceOfOperation are fixed for the life of the
    // accessory; re-writing them every poll is pointless work (they are not
    // writable and would be silently reverted by the Matter thermostat server).
    const { Thermostat } = matter.types;
    const uuid = this.heatingUuid(zone.id);
    const state: Record<string, unknown> = {
      localTemperature: this.toMatterTemperature(zone.currentTemperature),
      occupiedHeatingSetpoint: this.toMatterTemperature(zone.targetTemperature),
      systemMode: this.matterModeFromHive(zone.mode),
      thermostatRunningMode: zone.heating
        ? Thermostat.ThermostatRunningMode.Heat
        : Thermostat.ThermostatRunningMode.Off,
    };
    await this.writeIfChanged(uuid, matter.clusterNames.Thermostat, state);
  }

  async updateHotWater(hw: HiveHotWater): Promise<void> {
    // Track the latest state even when Matter is off/unregistered, so command
    // handlers never fall back to a stale registration-time snapshot.
    this.latestHotWater.set(hw.id, hw);
    if (!this.enabled || !this.registered) {
      return;
    }
    const matter = this.api.matter!;
    await this.writeIfChanged(this.hotWaterUuid(hw.id), matter.clusterNames.OnOff, {
      onOff: hw.boosting,
    });
  }

  /**
   * Write `state` only when it differs from the last payload written for
   * `uuid`. Hive is polled every 15s but rarely changes, so this turns most
   * polls into no-ops instead of a Matter write per accessory per cycle. The
   * payload is recorded only after a successful write, so a failed one is
   * retried on the next poll.
   */
  private async writeIfChanged(
    uuid: string,
    cluster: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    const encoded = JSON.stringify(state);
    if (this.lastWritten.get(uuid) === encoded) {
      return;
    }
    await this.api.matter!.updateAccessoryState(uuid, cluster, state);
    this.lastWritten.set(uuid, encoded);
  }

  /**
   * Run a control handler, translating "not ready yet" into a Matter status
   * the controller can act on.
   *
   * Homebridge already wraps an unrecognised handler error as a generic
   * Status.Failure, which reads to a controller as "the command was attempted
   * and failed". A command that arrived before Hive authentication finished was
   * never attempted, so InvalidInState is the honest answer — the controller
   * can retry rather than surface a failure to the user. `api.matter.status` is
   * read off the api object rather than value-imported from `homebridge`, which
   * would break on installs that keep Homebridge in a separate node_modules
   * tree. It is absent before Homebridge 2.3.0, hence the fallback.
   */
  private async command(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      const status = (this.api.matter as Partial<MatterAPI> | undefined)?.status;
      if (err instanceof HiveNotReadyError && status) {
        throw new status.InvalidInState(err.message);
      }
      throw err;
    }
  }

  private heatingAccessory(zone: HiveHeatingZone): MatterAccessory<HiveMatterContext> {
    return {
      UUID: this.heatingUuid(zone.id),
      displayName: zone.name,
      // Built from Homebridge's bridge-provided type so Matter behavior classes
      // come from the running Homebridge instance, not this plugin's dependency
      // tree — composed with our own feature set where that is supported. See
      // composeThermostat(). Cool is inert (Hive cannot cool) but Auto is mapped
      // to the Hive schedule — see matterModeFromHive()/hiveModeFromMatter().
      deviceType: this.thermostat!.deviceType,
      manufacturer: 'Hive',
      model: 'Heating Zone',
      serialNumber: this.serialNumber(zone.id),
      context: { hiveId: zone.id, kind: 'heating' },
      clusters: {
        thermostat: this.heatingCluster(zone),
      },
      handlers: {
        thermostat: {
          systemModeChange: ({ systemMode }) =>
            this.command(async () => {
              await this.commands.setHeatingMode(
                zone.id,
                this.hiveModeFromMatter(systemMode),
              );
              this.commands.pollSoon();
            }),
          occupiedHeatingSetpointChange: ({ occupiedHeatingSetpoint }) =>
            this.command(async () => {
              await this.commands.setHeatingTarget(
                zone.id,
                occupiedHeatingSetpoint / CELSIUS_TO_MATTER,
              );
              this.commands.pollSoon();
            }),
        },
      },
    };
  }

  private hotWaterAccessory(
    matter: MatterAPI,
    hw: HiveHotWater,
  ): MatterAccessory<HiveMatterContext> {
    return {
      UUID: this.hotWaterUuid(hw.id),
      displayName: hw.name,
      deviceType: matter.deviceTypes.OnOffOutlet,
      manufacturer: 'Hive',
      model: 'Hot Water Boost',
      serialNumber: this.serialNumber(hw.id),
      context: { hiveId: hw.id, kind: 'hotwater' },
      clusters: {
        onOff: { onOff: hw.boosting },
      },
      handlers: {
        onOff: {
          on: () =>
            this.command(async () => {
              await this.commands.setHotWaterBoost(hw.id, this.hotWaterBoostMinutes);
              this.commands.pollSoon();
            }),
          off: () =>
            this.command(async () => {
              await this.commands.cancelHotWaterBoost(hw.id, this.previousMode(hw));
              this.commands.pollSoon();
            }),
          toggle: () =>
            this.command(async () => {
              if (this.current(hw).boosting) {
                await this.commands.cancelHotWaterBoost(hw.id, this.previousMode(hw));
              } else {
                await this.commands.setHotWaterBoost(hw.id, this.hotWaterBoostMinutes);
              }
              this.commands.pollSoon();
            }),
        },
      },
    };
  }

  /** The freshest known state for a hot water product, falling back to the
   * registration-time snapshot if no poll has landed yet. */
  private current(hw: HiveHotWater): HiveHotWater {
    return this.latestHotWater.get(hw.id) ?? hw;
  }

  private previousMode(hw: HiveHotWater): HiveMode {
    return this.current(hw).previousMode;
  }

  private heatingCluster(zone: HiveHeatingZone): Record<string, unknown> {
    const { Thermostat } = this.api.matter!.types;
    const min = this.toMatterTemperature(HIVE_MIN_TEMP);
    const max = this.toMatterTemperature(HIVE_MAX_TEMP);

    const cluster: Record<string, unknown> = {
      localTemperature: this.toMatterTemperature(zone.currentTemperature),
      occupiedHeatingSetpoint: this.toMatterTemperature(zone.targetTemperature),
      absMinHeatSetpointLimit: min,
      absMaxHeatSetpointLimit: max,
      minHeatSetpointLimit: min,
      maxHeatSetpointLimit: max,
      // Hive only heats, so advertise a heating-only control sequence even
      // when the Cooling feature is present to satisfy AutoMode's conformance.
      controlSequenceOfOperation: Thermostat.ControlSequenceOfOperation.HeatingOnly,
      systemMode: this.matterModeFromHive(zone.mode),
      thermostatRunningMode: zone.heating
        ? Thermostat.ThermostatRunningMode.Heat
        : Thermostat.ThermostatRunningMode.Off,

      // The cooling half is declared for two reasons, and must not be dropped
      // as "Hive cannot cool":
      //
      // 1. It is what makes AutoMode live. On Homebridge 2.3.x we cannot
      //    compose the cluster, and detectThermostatFeatures() reads exactly
      //    these attributes — without a cooling setpoint it yields Heating
      //    alone, and then `systemMode: Auto` (the Hive schedule) and
      //    thermostatRunningMode are both rejected by conformance.
      //
      // 2. ⚠️ AutoMode brings the deadband, and matter.js >= 0.17.7 validates
      //    the WHOLE cluster rather than just the attribute being written:
      //      maxCoolSetpointLimit - maxHeatSetpointLimit >= minSetpointDeadBand
      //      minCoolSetpointLimit - minHeatSetpointLimit >= minSetpointDeadBand
      //    An undeclared deadband defaults to 2.0°C and undeclared cooling
      //    limits fall back to the spec's 16–32°C, which against our 5–32°C
      //    heating range gives 3200 - 3200 = 0 and fails. The symptom is badly
      //    disconnected from the cause: registration succeeds, then EVERY later
      //    setpoint update is rejected with "Thermostat setpoints could not be
      //    reconciled within the configured limits".
      //
      // A zero deadband over an identical cooling range keeps both inequalities
      // trivially satisfiable. Cooling stays inert either way: the control
      // sequence is HeatingOnly and the cooling setpoint is pinned to the top of
      // the range, so cool - heat is never negative whatever the user asks for.
      minSetpointDeadBand: 0,
      occupiedCoolingSetpoint: max,
      absMinCoolSetpointLimit: min,
      absMaxCoolSetpointLimit: max,
      minCoolSetpointLimit: min,
      maxCoolSetpointLimit: max,
    };

    if (this.thermostat!.presets) {
      // Presets is forced on by older Homebridge builds (see composeThermostat)
      // and then REQUIRES presetTypes to hold 1–7 entries; an empty or absent
      // array fails the '1 to 7' constraint. One Occupied type satisfies that
      // without implementing preset management. On builds where Presets is not
      // live, setting this at all fails with 'Conformance "PRES"'.
      cluster.presetTypes = [{
        presetScenario: Thermostat.PresetScenario?.Occupied ?? 1,
        numberOfPresets: 1,
        // presetTypeFeatures is a Matter bitmap; matter.js expects an object
        // (not a numeric 0). An empty bitmap means "no optional features".
        presetTypeFeatures: {},
      }];
      cluster.numberOfPresets = 1;
    }

    return cluster;
  }

  private matterModeFromHive(mode: HiveMode): number {
    const { SystemMode } = this.api.matter!.types.Thermostat;
    switch (mode) {
      case 'OFF':
        return SystemMode.Off;
      case 'SCHEDULE':
        // Matter has no "schedule" mode, so surface the Hive schedule as Auto.
        // Auto is conformance AUTO — heatingCluster() declares the cooling half
        // that keeps the AutoMode feature live, so this value stays legal.
        return SystemMode.Auto;
      default:
        return SystemMode.Heat;
    }
  }

  private hiveModeFromMatter(systemMode: number): HiveMode {
    const { SystemMode } = this.api.matter!.types.Thermostat;
    switch (systemMode) {
      case SystemMode.Off:
        return 'OFF';
      case SystemMode.Auto:
        // Auto round-trips to the Hive schedule (see matterModeFromHive()).
        return 'SCHEDULE';
      default:
        // Heat -> MANUAL. A Cool tap never reaches here: controlSequenceOf
        // Operation is HeatingOnly, so matter.js rejects SystemMode.Cool before
        // the handler runs. MANUAL is a safe fallback for anything else.
        return 'MANUAL';
    }
  }

  private toMatterTemperature(temp: number): number {
    return Math.round(temp * CELSIUS_TO_MATTER);
  }

  private serialNumber(id: string): string {
    return id.replace(/[^a-zA-Z0-9]/g, '').slice(-32);
  }

  private heatingUuid(id: string): string {
    return this.api.matter!.uuid.generate(`hive-matter-heating-${id}`);
  }

  private hotWaterUuid(id: string): string {
    return this.api.matter!.uuid.generate(`hive-matter-hotwater-${id}`);
  }
}
