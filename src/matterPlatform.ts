import type { Logger, MatterAccessory, MatterAPI } from 'homebridge';
import { HIVE_MAX_TEMP, HIVE_MIN_TEMP, PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { HiveHeatingZone, HiveHotWater, HiveMode } from './hiveApi';

type MatterApiHost = {
  isMatterEnabled?: () => boolean;
  matter?: MatterAPI;
};

type HiveMatterCommands = {
  setHeatingMode(id: string, mode: HiveMode): Promise<void>;
  setHeatingTarget(id: string, temp: number, current?: HiveHeatingZone): Promise<void>;
  setHotWaterBoost(id: string, minutes: number): Promise<void>;
  cancelHotWaterBoost(id: string, returnTo?: HiveMode): Promise<void>;
  pollSoon(delayMs?: number): void;
};

type HiveMatterContext = {
  hiveId: string;
  kind: 'heating' | 'hotwater';
};

const CELSIUS_TO_MATTER = 100;

/** Writes per attribute that may be awaiting their echo; see pendingEcho. */
const MAX_PENDING_ECHOES = 8;

/**
 * How long to wait for registered thermostats to come online. Exported so the
 * tests can shorten it.
 */
export const VERIFY_DEADLINE_MS = 6000;

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
 * Occupancy is deliberately absent: Hive has no occupancy sensing, and
 * declaring `occupancy` is rejected outright wherever the feature is not
 * composed.
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
   * itself, oldest first, keyed `<uuid>#<attribute>`.
   *
   * ⚠️ Homebridge's thermostat behavior reacts to attribute *changes*, not to
   * controller commands, and nothing distinguishes a write made by this plugin
   * from one made by a controller — there is no local-actor guard anywhere in
   * the chain. So every value pushed during a poll comes straight back into
   * this plugin's own handlers, which would forward it to Hive as though the
   * user had asked for it: a temperature change made by the Hive schedule
   * would return as a manual setpoint.
   *
   * An echo is consumed when it arrives. A write that does not change the
   * endpoint produces no callback, though, so its expectation lingers — and
   * every poll re-expects the current values. That is only safe because a
   * genuine change discards the attribute's expectations (see isEcho()).
   * Without that, a controller moving 20 → 21 → 20 within one poll interval
   * would have its second write swallowed as an echo of the 20 the last poll
   * re-asserted, and Hive would never hear it.
   */
  private readonly pendingEcho = new Map<string, number[]>();

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
    this.thermostat = this.composeThermostat(matter);

    // Homebridge 2.3 and later restore cached endpoints into the bridge before
    // plugins start, and adopt one when the plugin re-registers its UUID —
    // keeping the endpoint where the shape is unchanged, rebuilding it itself
    // where it is not. Those are left alone, unless their product has left the
    // account: unregistering them first would throw that away and rebuild
    // every endpoint on every restart, the churn the restore exists to avoid.
    //
    // Anything cached but not restored is cleared before registering, as it
    // always was. Older Homebridge could not reuse a cached endpoint (it came
    // from another matter.js module instance, failing with "identify is not a
    // Behavior.Type").
    const live = new Set([
      ...state.zones.map((zone) => this.heatingUuid(zone.id)),
      ...state.hotWater.map((hw) => this.hotWaterUuid(hw.id)),
    ]);
    const restored = await this.restoredUuids(matter);
    await this.unregisterCached(
      matter,
      (uuid) => !live.has(uuid) || !restored.has(uuid),
    );

    if (live.size === 0) {
      this.registered = true;
      return;
    }

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
      // Only the thermostats are rebuilt; the hot water endpoints are healthy.
      const thermostats = new Set(state.zones.map((zone) => this.heatingUuid(zone.id)));
      await this.unregisterCached(matter, (uuid) => thermostats.has(uuid));
      await this.registerWith(matter, { zones: state.zones, hotWater: [] });
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

  /**
   * Unregister and forget the cached accessories `which` selects.
   *
   * ⚠️ Only ever pass accessories that are not live, or that will not be
   * registered again. Unregistering is fire-and-forget — Homebridge returns
   * before the endpoint is closed and drops it from its live map only once it
   * has — so re-registering a live UUID straight afterwards would race the
   * removal. register() keeps to that: a restored endpoint is either left for
   * Homebridge to adopt or belongs to a product that has gone, and the Presets
   * retry only rebuilds thermostats that never came online.
   */
  private async unregisterCached(
    matter: MatterAPI,
    which: (uuid: string) => boolean,
  ): Promise<void> {
    const previous = [...this.cached.values()].filter((accessory) => which(accessory.UUID));
    if (previous.length === 0) {
      return;
    }
    for (const accessory of previous) {
      this.cached.delete(accessory.UUID);
      // A fresh endpoint starts from the cluster values passed at
      // registration, so the change-detection baseline must not survive it.
      this.forgetWritten(accessory.UUID);
    }
    try {
      await matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, previous);
    } catch (err) {
      this.log.debug(
        `Hive: clearing previous Matter accessories: ${(err as Error).message}`,
      );
    }
  }

  /**
   * The cached accessories Homebridge has already restored into the bridge —
   * the ones whose state is readable before this plugin has registered
   * anything. Where Homebridge cannot read state back, it is assumed to
   * restore nothing.
   */
  private async restoredUuids(matter: MatterAPI): Promise<Set<string>> {
    const restored = new Set<string>();
    if (typeof matter.getAccessoryState !== 'function') {
      return restored;
    }
    for (const accessory of this.cached.values()) {
      try {
        if (await matter.getAccessoryState(accessory.UUID, this.stateCluster(matter, accessory))) {
          restored.add(accessory.UUID);
        }
      } catch {
        /* not restored */
      }
    }
    return restored;
  }

  /** The cluster whose state shows whether `accessory` has a live endpoint. */
  private stateCluster(matter: MatterAPI, accessory: MatterAccessory<HiveMatterContext>): string {
    return accessory.context?.kind === 'hotwater'
      ? matter.clusterNames.OnOff
      : matter.clusterNames.Thermostat;
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
    const deadlineMs = Date.now() + VERIFY_DEADLINE_MS;
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

    await this.writeReachable(uuid, zone.online);
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
    const uuid = this.hotWaterUuid(hw.id);
    await this.writeIfChanged(uuid, matter.clusterNames.OnOff, { onOff: hw.boosting });
    await this.writeReachable(uuid, hw.online);
  }

  /**
   * Report every accessory as unreachable while Hive is not answering. The
   * next update for each puts its real reachability back.
   */
  async markUnreachable(): Promise<void> {
    if (!this.enabled || !this.registered) {
      return;
    }
    await Promise.all([
      ...[...this.latestHeating.keys()].map((id) => this.writeReachable(this.heatingUuid(id), false)),
      ...[...this.latestHotWater.keys()].map((id) => this.writeReachable(this.hotWaterUuid(id), false)),
    ]);
  }

  /**
   * Tell controllers whether the device behind `uuid` can be reached, through
   * the bridged-device information Homebridge composes onto every bridged
   * endpoint — Matter's equivalent of No Response. Homebridge builds that do
   * not name the cluster are left alone.
   */
  private async writeReachable(uuid: string, reachable: boolean): Promise<void> {
    const matter = this.api.matter!;
    const cluster = (matter.clusterNames as Partial<MatterAPI['clusterNames']>)
      .BridgedDeviceBasicInformation;
    if (cluster) {
      await this.writeIfChanged(uuid, cluster, { reachable }, 'reachable');
    }
  }

  /**
   * Write `state` only when it differs from the last payload written for
   * `uuid`. Hive is polled every 15s but rarely changes, so this turns most
   * polls into no-ops instead of a Matter write per accessory per cycle. A
   * write that throws is not recorded, so it is retried on the next poll —
   * though Homebridge 2.4 applies the write after returning, so a failure
   * there reaches only its own log.
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
    const key = `${uuid}#${attribute}`;
    const expected = this.pendingEcho.get(key) ?? [];
    if (expected[expected.length - 1] !== value) {
      expected.push(value);
      // Only writes whose echo never arrives (Homebridge dropped them) could
      // pile up here, so the oldest can safely go.
      expected.splice(0, expected.length - MAX_PENDING_ECHOES);
      this.pendingEcho.set(key, expected);
    }
  }

  /**
   * True when a reported change is this plugin's own write coming back.
   *
   * Anything else is a controller, and discards every expectation for the
   * attribute: once a controller has moved the endpoint, a value we wrote
   * earlier can only come back if something moves it there again — and if a
   * controller does that, it is a real request. The one exception is a write
   * of ours still in flight at that instant, a one-tick window whose worst case
   * is sending Hive the value it already has.
   */
  private isEcho(uuid: string, attribute: string, value: number): boolean {
    const key = `${uuid}#${attribute}`;
    const expected = this.pendingEcho.get(key) ?? [];
    const index = expected.indexOf(value);
    if (index < 0) {
      this.pendingEcho.delete(key);
      return false;
    }
    // Writes land in order, so anything expected before this one was overtaken.
    expected.splice(0, index + 1);
    if (expected.length === 0) {
      this.pendingEcho.delete(key);
    }
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
          systemModeChange: async ({ systemMode }) => {
            if (this.isEcho(this.heatingUuid(zone.id), 'systemMode', systemMode)) {
              return;
            }
            await this.commands.setHeatingMode(zone.id, this.hiveModeFromMatter(systemMode));
            this.commands.pollSoon();
          },
          occupiedHeatingSetpointChange: async ({ occupiedHeatingSetpoint }) => {
            // Two ways this is not a user asking for a temperature: our own
            // poll write coming back (see pendingEcho), and matter.js dragging
            // the heating setpoint to keep the deadband after a cooling write
            // (see reconcilingSetpoints). Forwarding either to Hive would change
            // the zone's real target on its own. The drag is checked first so
            // it leaves the echo expectations alone: the repair it triggered
            // has just queued the writes those expectations are for.
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
              this.currentZone(zone),
            );
            this.commands.pollSoon();
          },
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
          occupiedCoolingSetpointChange: async ({ occupiedCoolingSetpoint }) => {
            const uuid = this.heatingUuid(zone.id);
            if (this.isEcho(uuid, 'occupiedCoolingSetpoint', occupiedCoolingSetpoint)) {
              return;
            }
            await this.absorbCoolingWrite(zone.id);
          },
          setpointRaiseLower: async ({ mode, amount }) => {
            const { SetpointRaiseLowerMode } = this.api.matter!.types.Thermostat;
            // Homebridge runs matter.js's own implementation after this handler
            // returns, and that is what moves the endpoint: a Heat adjustment
            // then reaches Hive through occupiedHeatingSetpointChange, and a
            // Cool one is repaired by occupiedCoolingSetpointChange. Acting on
            // either here as well would send Hive the same change twice.
            if (mode !== (SetpointRaiseLowerMode?.Both ?? 2)) {
              return;
            }
            // Both is the exception. matter.js moves the pair together and the
            // cooling setpoint is pinned to the top of its range, so a raise
            // has no room and is cancelled outright, and a lower moves the
            // cooling setpoint first, making the heating half collateral of a
            // cooling write. Either way the heating change only reaches Hive
            // from here. `amount` is a delta in 0.1°C steps.
            const current = this.currentZone(zone);
            const target = Math.min(
              HIVE_MAX_TEMP,
              Math.max(HIVE_MIN_TEMP, current.targetTemperature + amount / 10),
            );
            await this.commands.setHeatingTarget(zone.id, target, current);
            this.commands.pollSoon();
          },
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
          on: async () => {
            await this.commands.setHotWaterBoost(hw.id, this.hotWaterBoostMinutes);
            this.commands.pollSoon();
          },
          off: async () => {
            await this.commands.cancelHotWaterBoost(hw.id, this.current(hw).mode);
            this.commands.pollSoon();
          },
          toggle: async () => {
            const current = this.current(hw);
            if (current.boosting) {
              await this.commands.cancelHotWaterBoost(hw.id, current.mode);
            } else {
              await this.commands.setHotWaterBoost(hw.id, this.hotWaterBoostMinutes);
            }
            this.commands.pollSoon();
          },
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
