import type { Logger, MatterAccessory, MatterAPI } from 'homebridge';
import { promises as fs } from 'fs';
import { HIVE_MAX_TEMP, HIVE_MIN_TEMP, PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { HiveHeatingZone, HiveHotWater, HiveMode } from './hiveApi';

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
 * Default assumption for the Matter Presets feature on a first run (no
 * remembered value). Current Homebridge 2.x runtime thermostats require a
 * non-empty `presetTypes` array, and the device-type template cannot be trusted
 * to reveal this (see register()). Defaulting to enabled makes the common case
 * succeed on the first attempt; the self-healing retry covers the exceptions.
 */
const DEFAULT_PRESETS_ENABLED = true;

export class HiveMatterPlatform {
  private readonly cached = new Map<string, MatterAccessory<HiveMatterContext>>();
  private registered = false;
  /** Whether the current/last registration attempt includes preset attributes. */
  private activePresets = false;

  constructor(
    private readonly api: MatterApiHost,
    private readonly log: Logger,
    private readonly commands: HiveMatterCommands,
    private readonly hotWaterBoostMinutes: number,
    /**
     * Optional path used to remember the working Matter Presets decision
     * across restarts, so subsequent starts skip the failed first attempt.
     * When omitted, persistence is disabled.
     */
    private readonly presetsStorePath?: string,
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

    // Whether the Matter thermostat needs preset attributes depends on the
    // running Homebridge build, and it CANNOT be read reliably from the device
    // type: Homebridge wraps the thermostat in its own runtime behaviour
    // (HomebridgeThermostatServer), so the device-type template can report
    // presets:false while the live endpoint still requires a non-empty
    // presetTypes array. Current Homebridge 2.x builds require it, so we default
    // the first guess to "enabled". We then verify each thermostat endpoint
    // actually came online — a thermostat that failed validation never enters
    // the live accessory map, so getAccessoryState stays undefined — and flip +
    // re-register once if the guess was wrong. The working value is remembered
    // so later restarts skip the verification round-trip entirely.
    const remembered = await this.loadPersistedPresets();
    this.activePresets = remembered ?? DEFAULT_PRESETS_ENABLED;
    if (remembered !== undefined) {
      this.log.info(`Hive: using remembered Matter Presets setting = ${remembered}.`);
    }
    await this.registerWith(matter, state);

    let ok = state.zones.length === 0 || (await this.verifyThermostats(matter, state));
    if (!ok) {
      this.log.warn(
        `Hive: thermostat(s) did not register with Presets=${this.activePresets}; ` +
          `retrying with Presets=${!this.activePresets}.`,
      );
      this.activePresets = !this.activePresets;
      await this.unregisterCached(matter);
      await this.registerWith(matter, state);
      ok = await this.verifyThermostats(matter, state);
      if (ok) {
        this.log.info(
          `Hive: thermostats registered after retry with Presets=${this.activePresets}.`,
        );
      } else {
        this.log.error(
          'Hive: thermostats still failed to register after retrying the Presets ' +
            'setting. Please open a GitHub issue with the Homebridge log.',
        );
      }
    }

    // Remember the working decision (only when there were thermostats to
    // verify, and only when it changed) so the next restart starts correct.
    if (ok && state.zones.length > 0 && this.activePresets !== remembered) {
      await this.savePersistedPresets(this.activePresets);
    }

    this.registered = true;
  }

  /** Read the remembered Presets decision, or undefined if none/unavailable. */
  private async loadPersistedPresets(): Promise<boolean | undefined> {
    if (!this.presetsStorePath) {
      return undefined;
    }
    try {
      const raw = await fs.readFile(this.presetsStorePath, 'utf8');
      const value = JSON.parse(raw).presets;
      return typeof value === 'boolean' ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /** Persist the working Presets decision for the next restart. */
  private async savePersistedPresets(value: boolean): Promise<void> {
    if (!this.presetsStorePath) {
      return;
    }
    try {
      await fs.writeFile(this.presetsStorePath, JSON.stringify({ presets: value }));
    } catch (err) {
      this.log.debug(
        `Hive: could not persist Matter Presets setting: ${(err as Error).message}`,
      );
    }
  }

  /** Build and register all accessories using the current Presets decision. */
  private async registerWith(
    matter: MatterAPI,
    state: { zones: HiveHeatingZone[]; hotWater: HiveHotWater[] },
  ): Promise<void> {
    const accessories = [
      ...state.zones.map((zone) => this.heatingAccessory(matter, zone)),
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
    await matter.updateAccessoryState(
      this.heatingUuid(zone.id),
      matter.clusterNames.Thermostat,
      {
        localTemperature: this.toMatterTemperature(zone.currentTemperature),
        occupiedHeatingSetpoint: this.toMatterTemperature(zone.targetTemperature),
        systemMode: this.matterModeFromHive(zone.mode),
        thermostatRunningMode: zone.heating
          ? Thermostat.ThermostatRunningMode.Heat
          : Thermostat.ThermostatRunningMode.Off,
      },
    );
  }

  async updateHotWater(hw: HiveHotWater): Promise<void> {
    if (!this.enabled || !this.registered) {
      return;
    }
    const matter = this.api.matter!;
    await matter.updateAccessoryState(
      this.hotWaterUuid(hw.id),
      matter.clusterNames.OnOff,
      { onOff: hw.boosting },
    );
  }

  private heatingAccessory(
    matter: MatterAPI,
    zone: HiveHeatingZone,
  ): MatterAccessory<HiveMatterContext> {
    return {
      UUID: this.heatingUuid(zone.id),
      displayName: zone.name,
      // Use Homebridge's bridge-provided type so Matter behavior classes come
      // from the running Homebridge instance, not this plugin's dependency tree.
      deviceType: matter.deviceTypes.Thermostat,
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
            await this.commands.setHeatingMode(
              zone.id,
              this.hiveModeFromMatter(systemMode),
            );
            this.commands.pollSoon();
          },
          occupiedHeatingSetpointChange: async ({ occupiedHeatingSetpoint }) => {
            await this.commands.setHeatingTarget(
              zone.id,
              occupiedHeatingSetpoint / CELSIUS_TO_MATTER,
            );
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
            await this.commands.cancelHotWaterBoost(hw.id, hw.previousMode);
            this.commands.pollSoon();
          },
          toggle: async () => {
            if (hw.boosting) {
              await this.commands.cancelHotWaterBoost(hw.id, hw.previousMode);
            } else {
              await this.commands.setHotWaterBoost(hw.id, this.hotWaterBoostMinutes);
            }
            this.commands.pollSoon();
          },
        },
      },
    };
  }

  private heatingCluster(zone: HiveHeatingZone) {
    const { Thermostat } = this.api.matter!.types;
    const base = {
      localTemperature: this.toMatterTemperature(zone.currentTemperature),
      occupancy: { occupied: true },
      occupiedHeatingSetpoint: this.toMatterTemperature(zone.targetTemperature),
      absMinHeatSetpointLimit: this.toMatterTemperature(HIVE_MIN_TEMP),
      absMaxHeatSetpointLimit: this.toMatterTemperature(HIVE_MAX_TEMP),
      minHeatSetpointLimit: this.toMatterTemperature(HIVE_MIN_TEMP),
      maxHeatSetpointLimit: this.toMatterTemperature(HIVE_MAX_TEMP),
      // Hive only heats, so present a heating-only control sequence. This
      // constrains the system mode to Off/Heat (Auto is still permitted by the
      // bridge thermostat type's AutoMode feature, but Cool/Precooling are
      // rejected).
      controlSequenceOfOperation: Thermostat.ControlSequenceOfOperation.HeatingOnly,
      systemMode: this.matterModeFromHive(zone.mode),
      thermostatRunningMode: zone.heating
        ? Thermostat.ThermostatRunningMode.Heat
        : Thermostat.ThermostatRunningMode.Off,
    };

    // The Matter Presets feature is enabled on some Homebridge / matter.js
    // builds and disabled on others, with opposite, mutually exclusive
    // requirements:
    //   • Presets ENABLED  → presetTypes MUST have 1–7 entries; an empty/absent
    //     array fails with constraint '1 to 7' (Array length 0 ...).
    //   • Presets DISABLED → presetTypes MUST NOT be set at all; setting it
    //     fails with 'Conformance "PRES": Matter does not allow you to set
    //     this attribute'.
    // `activePresets` is chosen by register(): the remembered value, else the
    // DEFAULT_PRESETS_ENABLED first guess, corrected by the self-healing retry
    // if the guess was wrong. We declare a single Occupied preset type to
    // satisfy the 1–7 constraint without implementing preset management.
    if (!this.activePresets) {
      return base;
    }
    return {
      ...base,
      presetTypes: [{
        presetScenario: Thermostat.PresetScenario?.Occupied ?? 1,
        numberOfPresets: 1,
        // presetTypeFeatures is a Matter bitmap; matter.js expects an object
        // (not a numeric 0). An empty bitmap means "no optional features".
        presetTypeFeatures: {},
      }],
      numberOfPresets: 1,
    };
  }

  private matterModeFromHive(mode: HiveMode): number {
    const { SystemMode } = this.api.matter!.types.Thermostat;
    switch (mode) {
      case 'OFF':
        return SystemMode.Off;
      default:
        return SystemMode.Heat;
    }
  }

  private hiveModeFromMatter(systemMode: number): HiveMode {
    const { SystemMode } = this.api.matter!.types.Thermostat;
    switch (systemMode) {
      case SystemMode.Off:
        return 'OFF';
      default:
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
