/**
 * HiveThermostatPlatform — the dynamic platform plugin entry point.
 *
 * Auth lifecycle (designed around Homebridge's static config UI):
 *   1. User enters username + password, saves, restarts.
 *   2. If the account has SMS 2FA, the platform logs a clear prompt and waits.
 *      The user reads the SMS, puts the code in the `smsCode` config field,
 *      and restarts again.
 *   3. On success the refresh token is persisted to disk; subsequent restarts
 *      silently refresh and never need the SMS field again. The user can clear
 *      smsCode afterwards.
 */

import {
  API,
  APIEvent,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  MatterAccessory,
} from 'homebridge';
import { promises as fs } from 'fs';
import path from 'path';

import {
  PLATFORM_NAME,
  PLUGIN_NAME,
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
} from './settings';
import { HiveAuth, HiveSmsRequired, HiveTokens } from './hiveAuth';
import { HiveApi, HiveNotReadyError, HiveState, TokenExpiredError } from './hiveApi';
import { HiveHeatingAccessory } from './heatingAccessory';
import { HiveHotWaterAccessory } from './hotWaterAccessory';
import { HiveMatterPlatform } from './matterPlatform';

interface HiveConfig extends PlatformConfig {
  username?: string;
  password?: string;
  smsCode?: string;
  pollInterval?: number;
  hotWaterDurationMinutes?: number;
  enableMatter?: boolean;
}

export class HiveThermostatPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: PlatformAccessory[] = [];

  private readonly cfg: HiveConfig;
  private auth?: HiveAuth;
  private api?: HiveApi;
  private tokens?: HiveTokens;

  private readonly tokenStorePath: string;
  private pollTimer?: NodeJS.Timeout;
  /** True while a poll is in flight, so cycles cannot overlap. */
  private polling = false;
  private readonly pollIntervalMs: number;
  private readonly hotWaterBoostMinutes: number;
  private readonly matterPlatform?: HiveMatterPlatform;

  /** Handlers keyed by hive product id, so polling can push updates. */
  private readonly handlers = new Map<
    string,
    HiveHeatingAccessory | HiveHotWaterAccessory
  >();

  constructor(
    public readonly log: Logger,
    config: PlatformConfig,
    public readonly homebridgeApi: API,
  ) {
    this.Service = homebridgeApi.hap.Service;
    this.Characteristic = homebridgeApi.hap.Characteristic;
    this.cfg = config as HiveConfig;

    // Guard against a non-numeric pollInterval in config: `NaN` would survive
    // Math.max and make setInterval fire continuously, hammering the Hive API.
    const configuredSeconds = Number(this.cfg.pollInterval);
    this.pollIntervalMs = Number.isFinite(configuredSeconds)
      ? Math.max(MIN_POLL_INTERVAL_MS, configuredSeconds * 1000)
      : DEFAULT_POLL_INTERVAL_MS;

    const boostMinutes = Number(this.cfg.hotWaterDurationMinutes);
    this.hotWaterBoostMinutes =
      Number.isFinite(boostMinutes) && boostMinutes > 0 ? boostMinutes : 30;
    if (this.cfg.enableMatter !== false) {
      this.matterPlatform = new HiveMatterPlatform(
        this.homebridgeApi,
        this.log,
        {
          setHeatingMode: (id, mode) => this.hive.setHeatingMode(id, mode),
          setHeatingTarget: (id, temp) => this.hive.setHeatingTarget(id, temp),
          setHotWaterBoost: (id, minutes) => this.hive.setHotWaterBoost(id, minutes),
          cancelHotWaterBoost: (id, previousMode) =>
            this.hive.cancelHotWaterBoost(id, previousMode),
          pollSoon: () => this.pollSoon(),
        },
        this.hotWaterBoostMinutes,
      );
    }

    this.tokenStorePath = path.join(
      this.homebridgeApi.user.storagePath(),
      '.hive-thermostat-tokens.json',
    );

    if (!this.cfg.username || !this.cfg.password) {
      this.log.error(
        'Hive username and password are required. Set them in the plugin config.',
      );
      return;
    }

    this.homebridgeApi.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      this.bootstrap().catch((err) =>
        this.log.error(`Hive startup failed: ${err.message}`),
      );
    });

    this.homebridgeApi.on(APIEvent.SHUTDOWN, () => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
      }
      if (this.pollSoonTimer) {
        clearTimeout(this.pollSoonTimer);
      }
    });
  }

  /** Restore cached accessories so HomeKit keeps their identity across restarts. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.push(accessory);
  }

  configureMatterAccessory(accessory: MatterAccessory): void {
    this.matterPlatform?.configureAccessory(accessory as Parameters<
      HiveMatterPlatform['configureAccessory']
    >[0]);
  }

  // ---- Auth bootstrap ------------------------------------------------------

  private async bootstrap(): Promise<void> {
    this.auth = new HiveAuth(this.cfg.username!, this.cfg.password!, this.log);

    // 1. Try a stored refresh token first — the happy path on every restart.
    const stored = await this.loadRefreshToken();
    if (stored) {
      try {
        this.tokens = await this.auth.refreshFromToken(stored);
        this.log.info('Hive: restored session from stored refresh token.');
      } catch (err) {
        this.log.warn(
          'Hive: stored refresh token rejected, will re-authenticate. ' +
            `(${(err as Error).message})`,
        );
        this.tokens = undefined;
      }
    }

    // 2. No usable token — do a fresh login (which may need SMS 2FA).
    if (!this.tokens) {
      try {
        this.tokens = await this.auth.login();
        this.log.info('Hive: logged in (no 2FA required).');
      } catch (err) {
        if (err instanceof HiveSmsRequired) {
          await this.handleSmsChallenge();
          if (!this.tokens) {
            return; // waiting on the user to supply a code
          }
        } else {
          throw err;
        }
      }
    }

    await this.saveRefreshToken(this.tokens!.refreshToken);

    this.api = new HiveApi(() => this.tokens!.idToken, this.log);

    await this.discoverDevices();
    this.startPolling();
  }

  private async handleSmsChallenge(): Promise<void> {
    if (this.cfg.smsCode) {
      try {
        this.tokens = await this.auth!.submitSms(this.cfg.smsCode);
        this.log.info('Hive: 2FA accepted. You can now clear the smsCode field.');
      } catch (err) {
        this.log.error(
          `Hive: 2FA code rejected (${(err as Error).message}). ` +
            'Request a new code and update the smsCode field.',
        );
      }
    } else {
      this.log.warn(
        '============================================================\n' +
          'Hive requires SMS two-factor authentication.\n' +
          'A code has been sent to your phone. Enter it in the plugin\n' +
          'config "smsCode" field and restart Homebridge.\n' +
          '============================================================',
      );
    }
  }

  // ---- Token persistence ---------------------------------------------------

  private async loadRefreshToken(): Promise<string | undefined> {
    try {
      const raw = await fs.readFile(this.tokenStorePath, 'utf8');
      return JSON.parse(raw).refreshToken;
    } catch {
      return undefined;
    }
  }

  private async saveRefreshToken(refreshToken: string): Promise<void> {
    try {
      await fs.writeFile(
        this.tokenStorePath,
        JSON.stringify({ refreshToken }),
        { mode: 0o600 },
      );
      await fs.chmod(this.tokenStorePath, 0o600);
    } catch (err) {
      this.log.warn(`Hive: could not persist refresh token: ${(err as Error).message}`);
    }
  }

  // ---- Device discovery ----------------------------------------------------

  private async discoverDevices(): Promise<void> {
    let state: HiveState;
    try {
      state = await this.api!.getState();
    } catch (err) {
      this.log.error(`Hive: failed to fetch devices: ${(err as Error).message}`);
      return;
    }

    for (const zone of state.zones) {
      this.registerHeating(zone.id, zone.name);
      this.log.info(
        `Discovered heating zone "${zone.name}" ` +
          `(current ${zone.currentTemperature}°C, target ${zone.targetTemperature}°C, ` +
          `mode ${zone.mode}${zone.online ? '' : ', OFFLINE'}).`,
      );
    }
    for (const hw of state.hotWater) {
      this.registerHotWater(hw.id, hw.name);
      this.log.info(
        `Discovered hot water "${hw.name}" ` +
          `(${hw.on ? 'on' : 'off'}, mode ${hw.mode}` +
          `${hw.boosting ? ', boosting' : ''}${hw.online ? '' : ', OFFLINE'}).`,
      );
    }

    if (state.zones.length === 0 && state.hotWater.length === 0) {
      this.log.warn(
        'Hive: no heating zones or hot water found on this account. ' +
          'If you expected devices here, please open a GitHub issue with your ' +
          'Homebridge log.',
      );
    }

    // Remove stale accessories no longer present on the account.
    const liveIds = new Set([
      ...state.zones.map((z) => z.id),
      ...state.hotWater.map((h) => h.id),
    ]);
    const stale = this.accessories.filter((a) => !liveIds.has(a.context.hiveId));
    if (stale.length) {
      this.homebridgeApi.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      // Homebridge does not prune our own cache, so drop them here too — an
      // unregistered accessory left in the list would be matched by UUID on a
      // later discovery and handed to a handler that HomeKit no longer knows.
      for (const accessory of stale) {
        const index = this.accessories.indexOf(accessory);
        if (index >= 0) {
          this.accessories.splice(index, 1);
        }
      }
    }

    // Seed initial values.
    this.applyState(state);
    await this.matterPlatform?.register(state);
  }

  private registerHeating(id: string, name: string): void {
    const uuid = this.homebridgeApi.hap.uuid.generate(`hive-heating-${id}`);
    let accessory = this.accessories.find((a) => a.UUID === uuid);
    if (!accessory) {
      accessory = new this.homebridgeApi.platformAccessory(name, uuid);
      accessory.context.hiveId = id;
      this.homebridgeApi.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      // configureAccessory() only fires for accessories restored from cache, so
      // newly created ones have to be tracked here.
      this.accessories.push(accessory);
    } else if (accessory.displayName !== name) {
      // Keep the cached accessory's name in sync if Hive's name changed.
      accessory.displayName = name;
      this.homebridgeApi.updatePlatformAccessories([accessory]);
    }
    this.handlers.set(id, new HiveHeatingAccessory(this, accessory, id));
  }

  private registerHotWater(id: string, name: string): void {
    const uuid = this.homebridgeApi.hap.uuid.generate(`hive-hotwater-${id}`);
    let accessory = this.accessories.find((a) => a.UUID === uuid);
    if (!accessory) {
      accessory = new this.homebridgeApi.platformAccessory(name, uuid);
      accessory.context.hiveId = id;
      this.homebridgeApi.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    } else if (accessory.displayName !== name) {
      accessory.displayName = name;
      this.homebridgeApi.updatePlatformAccessories([accessory]);
    }
    this.handlers.set(id, new HiveHotWaterAccessory(this, accessory, id, this.hotWaterBoostMinutes));
  }

  // ---- Polling -------------------------------------------------------------

  private startPolling(): void {
    this.pollTimer = setInterval(() => this.pollOnce(), this.pollIntervalMs);
  }

  /**
   * A single poll cycle: fetch state and push it to the accessories.
   *
   * Guarded against overlap — the request timeout (15s) is the same as the
   * default poll interval, so a slow Hive response could otherwise stack up
   * concurrent polls that each retry auth and fight over the token.
   */
  private async pollOnce(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      this.applyState(await this.api!.getState());
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        // Refresh and retry immediately rather than serving stale state until
        // the next tick.
        await this.refreshTokens();
        try {
          this.applyState(await this.api!.getState());
        } catch (retryErr) {
          this.log.debug(`Hive poll retry failed: ${(retryErr as Error).message}`);
        }
      } else {
        this.log.debug(`Hive poll error: ${(err as Error).message}`);
      }
    } finally {
      this.polling = false;
    }
  }

  /**
   * Schedule a one-off poll shortly after a control command, so HomeKit
   * reflects the confirmed device state without waiting for the next regular
   * poll. Multiple rapid calls collapse into a single refresh.
   */
  private pollSoonTimer?: NodeJS.Timeout;
  pollSoon(delayMs = 4000): void {
    if (this.pollSoonTimer) {
      clearTimeout(this.pollSoonTimer);
    }
    this.pollSoonTimer = setTimeout(() => {
      this.pollSoonTimer = undefined;
      if (this.polling) {
        // A regular poll is already in flight and may have read Hive before the
        // command landed, so its result can't confirm anything. Re-arm rather
        // than let the overlap guard drop this cycle.
        this.pollSoon(1000);
        return;
      }
      void this.pollOnce();
    }, delayMs);
  }

  private applyState(state: HiveState): void {
    for (const zone of state.zones) {
      const h = this.handlers.get(zone.id);
      if (h instanceof HiveHeatingAccessory) {
        h.update(zone);
      }
      this.matterPlatform?.updateHeating(zone).catch((err) =>
        this.log.debug(`Hive Matter heating update failed: ${(err as Error).message}`),
      );
    }
    for (const hw of state.hotWater) {
      const h = this.handlers.get(hw.id);
      if (h instanceof HiveHotWaterAccessory) {
        h.update(hw);
      }
      this.matterPlatform?.updateHotWater(hw).catch((err) =>
        this.log.debug(`Hive Matter hot water update failed: ${(err as Error).message}`),
      );
    }
  }

  /** Refresh id/access tokens using the stored refresh token. */
  async refreshTokens(): Promise<void> {
    if (!this.auth || !this.tokens) {
      return;
    }
    try {
      this.tokens = await this.auth.refreshFromToken(this.tokens.refreshToken);
      await this.saveRefreshToken(this.tokens.refreshToken);
      this.log.debug('Hive: tokens refreshed.');
    } catch (err) {
      this.log.error(
        'Hive: token refresh failed. Re-authentication needed — ' +
          're-enter credentials and an SMS code in the config. ' +
          `(${(err as Error).message})`,
      );
    }
  }

  /** Exposed so accessories can issue control commands. */
  get hive(): HiveApi {
    if (!this.api) {
      // Cached Matter endpoints can stay live across a restart and accept a
      // command before auth finishes. Fail with something diagnosable rather
      // than a bare "cannot read properties of undefined" — the Matter layer
      // turns this into an InvalidInState status (see HiveMatterPlatform).
      throw new HiveNotReadyError();
    }
    return this.api;
  }
}
