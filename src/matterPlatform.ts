import type { Logger, MatterAccessory, MatterAPI } from 'homebridge';
import { HIVE_MAX_TEMP, HIVE_MIN_TEMP, PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { HiveHeatingZone, HiveHotWater, HiveMode } from './hiveApi';
import { HiveNotReadyError } from './errors';

type MatterApiHost = {
  isMatterEnabled?: () => boolean;
  matter?: MatterAPI;
};

type HiveMatterCommands = {
  setHeatingMode(id: string, mode: HiveMode): Promise<void>;
  setHeatingTarget(id: string, temp: number): Promise<void>;
  setHotWaterBoost(id: string, minutes: number): Promise<void>;
  cancelHotWaterBoost(id: string, previousMode?: HiveMode): Promise<void>;
  pollSoon(delayMs?: number): void;
};

type HiveMatterContext = {
  hiveId: string;
  kind: 'heating' | 'hotwater';
};

const CELSIUS_TO_MATTER = 100;

/**
 * The cooling range this thermostat advertises, in °C.
 *
 * Hive cannot cool, so these numbers describe nothing real — they exist only
 * to keep the Cooling feature (and with it AutoMode) legal. They are therefore
 * the Matter spec's own AbsMin/AbsMaxCoolSetpointLimit range rather than
 * Hive's heating range: matter.js does not enforce it (the model element
 * carries `constraint: "desc"`), but a stricter third-party controller may,
 * and a 5°C cooling floor on a device with no compressor is a fiction with no
 * upside. The deadband arithmetic is satisfied either way — see
 * heatingCluster() for the inequalities that actually matter.
 */
const COOL_MIN_TEMP = 16;
const COOL_MAX_TEMP = 32;

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

  /** Latest heating zone state per Hive product id, for the same reason. */
  private readonly latestHeating = new Map<string, HiveHeatingZone>();

  /**
   * Attribute values this plugin has written and expects to see handed back to
   * itself, keyed `<uuid>#<attribute>`.
   *
   * ⚠️ Homebridge's thermostat behavior reacts to attribute *changes*, not to
   * controller commands, and nothing distinguishes a write made by this plugin
   * from one made by a controller — there is no local-actor guard anywhere in
   * the chain. So every value pushed during a poll comes straight back into
   * this plugin's own handlers, which would forward it to Hive as though the
   * user had asked for it. That is not cosmetic: setHeatingTarget() also sends
   * `mode: MANUAL`, so a temperature change made by the Hive schedule would
   * echo back and switch the zone off the very schedule it came from.
   *
   * An echo is consumed when it arrives. If a write turns out to be a no-op the
   * entry simply waits, and the worst case is that one later controller write
   * of that exact same value is treated as an echo — which costs a redundant
   * command to Hive, never a wrong one.
   */
  private readonly pendingEcho = new Map<string, number>();

  /**
   * Zones whose heating setpoint is currently being moved by matter.js's own
   * deadband reconciliation rather than by a controller.
   *
   * Writing the cooling setpoint makes matter.js drag the heating setpoint to
   * match, inside the same transaction, and Homebridge reports that as an
   * ordinary heating change — so without this the drag reaches Hive as a real
   * setpoint command. The cooling event fires before the heating one it causes
   * (the originating attribute is committed first), so the marker is always set
   * in time, and it is dropped on the next tick so it can never swallow a
   * genuine change.
   */
  private readonly reconcilingSetpoints = new Set<string>();

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

    // The feature set is derived rather than guessed, so verification is
    // normally just a health check. It is still wired to a retry, because the
    // one thing composeThermostat() cannot derive is a Homebridge generation
    // that does not exist yet: a future release that pre-composes the device
    // type differently would land us on the wrong side of the Presets decision,
    // matter.js would reject the endpoint for conformance, and a thermostat
    // that fails validation never enters the live accessory map — its state
    // stays unreadable for the life of the process. Flipping the one derived
    // bit and re-registering costs a few seconds at startup and turns that
    // dead accessory back into a working one.
    if (state.zones.length > 0 && !(await this.verifyThermostats(matter, state))) {
      this.log.warn(
        `Hive: thermostat endpoint(s) did not come online with Presets=${this.thermostat.presets}. ` +
          'Retrying once with the opposite setting.',
      );
      this.thermostat = { ...this.thermostat, presets: !this.thermostat.presets };
      await this.unregisterCached(matter);
      await this.registerWith(matter, state);
      if (!(await this.verifyThermostats(matter, state))) {
        this.log.error(
          'Hive: thermostat endpoint(s) did not come online. Please open a GitHub ' +
            'issue with the Homebridge log and your Homebridge version.',
        );
      } else {
        this.log.info(
          `Hive: thermostat endpoint(s) online with Presets=${this.thermostat.presets}.`,
        );
      }
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
   *
   * `getAccessoryState` is optional at runtime (older Homebridge has no such
   * method). Without it there is nothing to observe, so report success rather
   * than burn the whole deadline and then cry wolf about healthy endpoints on
   * every single startup.
   */
  private async verifyThermostats(
    matter: MatterAPI,
    state: { zones: HiveHeatingZone[] },
  ): Promise<boolean> {
    if (typeof matter.getAccessoryState !== 'function') {
      this.log.debug(
        'Hive: this Homebridge cannot read back Matter state; skipping thermostat verification.',
      );
      return true;
    }
    const pending = new Set(state.zones.map((z) => this.heatingUuid(z.id)));
    const deadlineMs = Date.now() + 6000;
    while (pending.size > 0 && Date.now() < deadlineMs) {
      for (const uuid of [...pending]) {
        try {
          const st = await matter.getAccessoryState(uuid, matter.clusterNames.Thermostat);
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
    // Track the latest state even when Matter is off/unregistered, so command
    // handlers never fall back to a stale registration-time snapshot.
    this.latestHeating.set(zone.id, zone);
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
    const cluster = matter.clusterNames.Thermostat;

    // ⚠️ systemMode goes in its OWN write, first, and the order is load-bearing.
    // matter.js reacts to a systemMode change by forcing thermostatRunningMode
    // to match it (ThermostatServer#handleSystemModeChange), as a local actor,
    // and that reaction has already run by the time the write resolves. Sending
    // both attributes in one payload therefore loses our running mode
    // permanently: writeIfChanged records the payload we *intended*, so a zone
    // switched to MANUAL while the boiler is idle would report "heating" until
    // the next restart. Landing the mode change on its own lets the reaction
    // run and then be corrected by the write below.
    const systemMode = this.matterModeFromHive(zone.mode);
    this.expectEcho(uuid, 'systemMode', systemMode);
    const modeChanged = await this.writeIfChanged(uuid, cluster, { systemMode }, 'mode');
    if (modeChanged) {
      // ...but only if that correction is actually sent. The payload below is
      // usually identical to last poll's — the mode moved, not the temperature
      // — and change detection would skip the one write that undoes the
      // reaction. A mode write means the endpoint no longer matches what we
      // recorded, so the baseline has to go.
      this.forgetWritten(uuid, 'state');
    }

    const heatingSetpoint = this.toMatterTemperature(zone.targetTemperature);
    const coolingSetpoint = this.toMatterTemperature(COOL_MAX_TEMP);
    this.expectEcho(uuid, 'occupiedHeatingSetpoint', heatingSetpoint);
    this.expectEcho(uuid, 'occupiedCoolingSetpoint', coolingSetpoint);

    await this.writeIfChanged(uuid, cluster, {
      localTemperature: this.toMatterTemperature(zone.currentTemperature),
      occupiedHeatingSetpoint: heatingSetpoint,
      thermostatRunningMode: zone.heating
        ? Thermostat.ThermostatRunningMode.Heat
        : Thermostat.ThermostatRunningMode.Off,
      // Re-assert the cooling pin every time the rest of the payload moves.
      // heatingCluster() sets it once at registration, but a controller can
      // write it afterwards, and matter.js reconciles the pair — so an
      // unrestored cooling setpoint drags the heating setpoint down with it.
      occupiedCoolingSetpoint: coolingSetpoint,
    }, 'state');
  }

  /**
   * Rewrite a zone's whole Matter payload from the freshest Hive state we
   * have, discarding the change-detection baseline first so the write is not
   * skipped as a no-op.
   *
   * This is the repair path for a controller writing an attribute we do not
   * actually support: the endpoint has moved, Hive has not, and the two have to
   * be brought back into line without waiting for Hive to change on its own.
   */
  private async restoreHeating(zoneId: string): Promise<void> {
    const zone = this.latestHeating.get(zoneId);
    if (!zone) {
      return;
    }
    this.forgetWritten(this.heatingUuid(zoneId));
    await this.updateHeating(zone);
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
    part = '',
  ): Promise<boolean> {
    const encoded = JSON.stringify(state);
    if (this.lastWritten.get(this.writeKey(uuid, part)) === encoded) {
      return false;
    }
    await this.api.matter!.updateAccessoryState(uuid, cluster, state);
    this.lastWritten.set(this.writeKey(uuid, part), encoded);
    return true;
  }

  /**
   * Drop a change-detection baseline, so the next write of that payload is
   * sent even when it is byte-identical to the last one. Omitting `part`
   * forgets every payload recorded for the accessory.
   */
  private forgetWritten(uuid: string, part?: string): void {
    if (part !== undefined) {
      this.lastWritten.delete(this.writeKey(uuid, part));
      return;
    }
    for (const key of this.lastWritten.keys()) {
      if (key === uuid || key.startsWith(`${uuid}#`)) {
        this.lastWritten.delete(key);
      }
    }
  }

  private writeKey(uuid: string, part: string): string {
    return part ? `${uuid}#${part}` : uuid;
  }

  /** Record a value this plugin is about to write — see {@link pendingEcho}. */
  private expectEcho(uuid: string, attribute: string, value: number): void {
    this.pendingEcho.set(`${uuid}#${attribute}`, value);
  }

  /** True when a reported change is this plugin's own write coming back. */
  private isEcho(uuid: string, attribute: string, value: number): boolean {
    const key = `${uuid}#${attribute}`;
    if (this.pendingEcho.get(key) !== value) {
      return false;
    }
    this.pendingEcho.delete(key);
    return true;
  }

  /**
   * Absorb a cooling setpoint this device cannot honour: flag the heating
   * change matter.js is about to derive from it as collateral, then put both
   * setpoints back from the freshest Hive state.
   */
  private async absorbCoolingWrite(zoneId: string): Promise<void> {
    this.reconcilingSetpoints.add(zoneId);
    setImmediate(() => this.reconcilingSetpoints.delete(zoneId));
    await this.restoreHeating(zoneId);
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
              if (this.isEcho(this.heatingUuid(zone.id), 'systemMode', systemMode)) {
                return;
              }
              await this.commands.setHeatingMode(
                zone.id,
                this.hiveModeFromMatter(systemMode),
              );
              this.commands.pollSoon();
            }),
          occupiedHeatingSetpointChange: ({ occupiedHeatingSetpoint }) =>
            this.command(async () => {
              // Two ways this is not a user asking for a temperature: our own
              // poll write coming back (see pendingEcho), and matter.js
              // dragging the heating setpoint to keep the deadband after a
              // cooling write (see reconcilingSetpoints). Forwarding either to
              // Hive would change the zone's real target, and switch it to
              // MANUAL, on its own.
              const uuid = this.heatingUuid(zone.id);
              if (
                this.reconcilingSetpoints.has(zone.id) ||
                this.isEcho(uuid, 'occupiedHeatingSetpoint', occupiedHeatingSetpoint)
              ) {
                return;
              }
              await this.commands.setHeatingTarget(
                zone.id,
                occupiedHeatingSetpoint / CELSIUS_TO_MATTER,
              );
              this.commands.pollSoon();
            }),
          // Hive cannot cool, but Cooling is live on every Homebridge (it is
          // what keeps AutoMode legal — see THERMOSTAT_FEATURES), so a
          // controller can write this setpoint and Homebridge routes it
          // straight here. Not registering a handler is not the quiet option:
          // Homebridge rejects the write outright with Status.Failure and logs
          // an error for every attempt. Letting it stand is worse still —
          // matter.js reconciles the setpoint pair, so a cooling setpoint
          // dragged below the heating one takes the user's real heating target
          // down with it while Hive never hears about the change. Accept it,
          // then put both setpoints back.
          occupiedCoolingSetpointChange: ({ occupiedCoolingSetpoint }) =>
            this.command(async () => {
              const uuid = this.heatingUuid(zone.id);
              if (this.isEcho(uuid, 'occupiedCoolingSetpoint', occupiedCoolingSetpoint)) {
                return;
              }
              await this.absorbCoolingWrite(zone.id);
            }),
          setpointRaiseLower: ({ mode, amount }) =>
            this.command(async () => {
              const { SetpointRaiseLowerMode } = this.api.matter!.types.Thermostat;
              // `amount` is a delta in 0.1°C steps, and the command adjusts
              // whichever setpoints `mode` names. A Cool-only adjustment has no
              // Hive equivalent, so it is absorbed by the same repair path as a
              // direct cooling write.
              if (mode === (SetpointRaiseLowerMode?.Cool ?? 1)) {
                // Homebridge runs matter.js's own implementation after this
                // handler returns, so the cooling setpoint it moves is repaired
                // by occupiedCoolingSetpointChange above, not from here.
                return;
              }
              const current = this.currentZone(zone).targetTemperature;
              const target = Math.min(
                HIVE_MAX_TEMP,
                Math.max(HIVE_MIN_TEMP, current + amount / 10),
              );
              await this.commands.setHeatingTarget(zone.id, target);
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

  /** The same, for a heating zone. */
  private currentZone(zone: HiveHeatingZone): HiveHeatingZone {
    return this.latestHeating.get(zone.id) ?? zone;
  }

  private previousMode(hw: HiveHotWater): HiveMode {
    return this.current(hw).previousMode;
  }

  private heatingCluster(zone: HiveHeatingZone) {
    const { Thermostat } = this.api.matter!.types;
    const min = this.toMatterTemperature(HIVE_MIN_TEMP);
    const max = this.toMatterTemperature(HIVE_MAX_TEMP);
    const coolMin = this.toMatterTemperature(COOL_MIN_TEMP);
    const coolMax = this.toMatterTemperature(COOL_MAX_TEMP);

    return {
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
      //    An undeclared deadband defaults to 2.0°C, which against our 5–32°C
      //    heating range gives 3200 - 3200 = 0 and fails. The symptom is badly
      //    disconnected from the cause: registration succeeds, then EVERY later
      //    setpoint update is rejected with "Thermostat setpoints could not be
      //    reconciled within the configured limits".
      //
      // A zero deadband keeps both inequalities satisfiable over the spec's own
      // 16–32°C cooling range (3200 - 3200 = 0 and 1600 - 500 = 1100, both
      // >= 0). Cooling stays inert: the control sequence is HeatingOnly and the
      // setpoint is pinned to the top of the range. That pin is not
      // self-maintaining, though — a controller can move it, so
      // updateHeating() re-asserts it and occupiedCoolingSetpointChange()
      // repairs it.
      minSetpointDeadBand: 0,
      occupiedCoolingSetpoint: coolMax,
      absMinCoolSetpointLimit: coolMin,
      absMaxCoolSetpointLimit: coolMax,
      minCoolSetpointLimit: coolMin,
      maxCoolSetpointLimit: coolMax,

      // Presets is forced on by older Homebridge builds (see composeThermostat)
      // and then REQUIRES presetTypes to hold 1–7 entries; an empty or absent
      // array fails the '1 to 7' constraint. One Occupied type satisfies that
      // without implementing preset management. On builds where Presets is not
      // live, setting this at all fails with 'Conformance "PRES"' — hence the
      // conditional spread rather than a mutable `Record<string, unknown>`,
      // which would also cost every attribute name above its type check.
      ...(this.thermostat!.presets
        ? {
          presetTypes: [{
            presetScenario: Thermostat.PresetScenario?.Occupied ?? 1,
            numberOfPresets: 1,
            // presetTypeFeatures is a Matter bitmap; matter.js expects an
            // object (not a numeric 0). An empty bitmap means "no optional
            // features".
            presetTypeFeatures: {},
          }],
          numberOfPresets: 1,
        }
        : {}),
    };
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
