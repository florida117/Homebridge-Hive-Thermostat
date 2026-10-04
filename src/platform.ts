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
  STALE_AFTER_FAILED_POLLS,
  STARTUP_RETRY_MAX_MS,
  STARTUP_RETRY_MIN_MS,
} from './settings';
import { HiveAuth, HiveSmsRequired, HiveTokens, isTransientAuthError } from './hiveAuth';
import { HiveApi, HiveHeatingZone, HiveMode, HiveState, TokenExpiredError } from './hiveApi';
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

/** What `.hive-thermostat-tokens.json` holds. */
interface StoredTokens {
  refreshToken?: unknown;
  /** Absent in files written by 1.0.9 and earlier. */
  username?: unknown;
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
  private readonly legacyPresetsStorePath: string;
  private pollTimer?: NodeJS.Timeout;
  private pollSoonTimer?: NodeJS.Timeout;
  private startupRetryTimer?: NodeJS.Timeout;
  /** Failed startup attempts so far, for the retry backoff. */
  private startupAttempts = 0;
  /** Set on shutdown, so a startup still in flight does not arm new timers. */
  private shuttingDown = false;
  /** True while a poll is in flight, so cycles cannot overlap. */
  private polling = false;
  /**
   * True once discovery has registered accessories. Discovery is the only
   * thing that wires Hive product ids to handlers, so until it succeeds a poll
   * has nowhere to deliver state.
   */
  private discovered = false;
  /** Polls that have failed in a row; see STALE_AFTER_FAILED_POLLS. */
  private failedPolls = 0;
  /**
   * Whether the standing token-refresh failure has already been reported, so a
   * permanently rejected refresh token does not log an error every poll.
   */
  private authFailureReported = false;
  /** The refresh in flight, shared by every caller that hits a 401 meanwhile. */
  private refreshing?: Promise<boolean>;
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
          setHeatingMode: (id, mode) => this.setHeatingMode(id, mode),
          setHeatingTarget: (id, temp, current) =>
            this.setHeatingTarget(id, temp, current),
          setHotWaterBoost: (id, minutes) => this.setHotWaterBoost(id, minutes),
          cancelHotWaterBoost: (id, returnTo) =>
            this.cancelHotWaterBoost(id, returnTo),
          pollSoon: (delayMs) => this.pollSoon(delayMs),
        },
        this.hotWaterBoostMinutes,
      );
    }

    this.tokenStorePath = path.join(
      this.homebridgeApi.user.storagePath(),
      '.hive-thermostat-tokens.json',
    );

    // 1.0.4 persisted a guessed Matter Presets flag here. Nothing reads it any
    // more (see composeThermostat), so it is removed rather than left behind
    // with nothing to explain what it was.
    this.legacyPresetsStorePath = path.join(
      this.homebridgeApi.user.storagePath(),
      '.hive-thermostat-matter.json',
    );

    if (!this.cfg.username || !this.cfg.password) {
      this.log.error(
        'Hive username and password are required. Set them in the plugin config.',
      );
      return;
    }

    this.homebridgeApi.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      this.attachCachedHandlers();
      this.startup();
    });

    this.homebridgeApi.on(APIEvent.SHUTDOWN, () => {
      this.shuttingDown = true;
      clearInterval(this.pollTimer);
      clearTimeout(this.pollSoonTimer);
      clearTimeout(this.startupRetryTimer);
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

  // ---- Startup -------------------------------------------------------------

  /**
   * Run bootstrap(), retrying with backoff when Hive could not be reached.
   *
   * Homebridge often starts before the network does — after a power cut the
   * Pi boots faster than the router — and one failed attempt must not leave
   * the plugin inert until someone restarts it. A failure that is about the
   * account (a wrong password, a revoked session with no SMS code to hand) is
   * not retried: that would change nothing, and repeated wrong-password
   * attempts count towards Cognito's lockout.
   */
  private startup(): void {
    this.bootstrap().then(
      () => {
        this.startupAttempts = 0;
      },
      (err: Error) => {
        if (!isTransientAuthError(err)) {
          this.log.error(`Hive startup failed: ${err.message}`);
          return;
        }
        if (this.shuttingDown) {
          return;
        }
        const delayMs = Math.min(
          STARTUP_RETRY_MAX_MS,
          STARTUP_RETRY_MIN_MS * 2 ** this.startupAttempts++,
        );
        this.log.warn(
          `Hive: could not sign in (${err.message}). ` +
            `Retrying in ${Math.round(delayMs / 1000)}s.`,
        );
        this.startupRetryTimer = setTimeout(() => this.startup(), delayMs);
      },
    );
  }

  private async bootstrap(): Promise<void> {
    await fs.unlink(this.legacyPresetsStorePath).catch(() => {
      /* never existed, or already gone — either way there is nothing to do */
    });

    this.auth ??= new HiveAuth(this.cfg.username!, this.cfg.password!, this.log);
    if (!(await this.authenticate())) {
      return; // waiting on the user to supply an SMS code
    }

    await this.saveRefreshToken(this.tokens!.refreshToken);

    this.api = new HiveApi(() => this.tokens!.idToken, this.log);

    await this.discoverDevices();
    this.startPolling();
  }

  /**
   * Establish a Hive session: the stored refresh token if Hive still honours
   * it, otherwise a fresh login (which may need SMS 2FA).
   *
   * Resolves false when nothing more can happen until the user supplies an SMS
   * code. Throws on anything else; see startup() for which failures retry.
   */
  private async authenticate(): Promise<boolean> {
    const auth = this.auth!;

    // 1. Try a stored refresh token first — the happy path on every restart.
    const stored = await this.loadRefreshToken();
    if (stored) {
      try {
        this.tokens = await auth.refreshFromToken(stored);
        this.log.info('Hive: restored session from stored refresh token.');
        return true;
      } catch (err) {
        // A network failure says nothing about the token. Falling through to
        // a full login would text the user a 2FA code they did not ask for
        // and park the plugin waiting on it — so let startup() retry with the
        // stored token instead.
        if (isTransientAuthError(err)) {
          throw err;
        }
        this.log.warn(
          'Hive: stored refresh token rejected, will re-authenticate. ' +
            `(${(err as Error).message})`,
        );
      }
    }

    // 2. No usable token — do a fresh login (which may need SMS 2FA).
    try {
      this.tokens = await auth.login();
      this.log.info('Hive: logged in (no 2FA required).');
      return true;
    } catch (err) {
      if (!(err instanceof HiveSmsRequired)) {
        throw err;
      }
    }
    return this.handleSmsChallenge();
  }

  private async handleSmsChallenge(): Promise<boolean> {
    if (!this.cfg.smsCode) {
      this.log.warn(
        '============================================================\n' +
          'Hive requires SMS two-factor authentication.\n' +
          'A code has been sent to your phone. Enter it in the plugin\n' +
          'config "smsCode" field and restart Homebridge.\n' +
          '============================================================',
      );
      return false;
    }
    try {
      this.tokens = await this.auth!.submitSms(this.cfg.smsCode);
      this.log.info('Hive: 2FA accepted. You can now clear the smsCode field.');
      return true;
    } catch (err) {
      if (isTransientAuthError(err)) {
        throw err;
      }
      this.log.error(
        `Hive: 2FA code rejected (${(err as Error).message}). ` +
          'Request a new code and update the smsCode field.',
      );
      return false;
    }
  }

  // ---- Token persistence ---------------------------------------------------

  /**
   * Read the stored refresh token, if it belongs to the configured account.
   *
   * Cognito's refresh flow does not take a username, so a token from another
   * account would be honoured silently — someone switching Hive accounts in
   * the config would keep controlling the old one. Files written before the
   * username was recorded are trusted, rather than costing every upgrading
   * user a fresh SMS code.
   */
  private async loadRefreshToken(): Promise<string | undefined> {
    let stored: StoredTokens;
    try {
      stored = JSON.parse(await fs.readFile(this.tokenStorePath, 'utf8'));
    } catch {
      return undefined;
    }
    if (typeof stored.refreshToken !== 'string') {
      return undefined;
    }
    if (
      typeof stored.username === 'string' &&
      normaliseUsername(stored.username) !== normaliseUsername(this.cfg.username!)
    ) {
      this.log.info('Hive: the stored session belongs to a different account; signing in again.');
      return undefined;
    }
    return stored.refreshToken;
  }

  private async saveRefreshToken(refreshToken: string): Promise<void> {
    try {
      await fs.writeFile(
        this.tokenStorePath,
        JSON.stringify({ refreshToken, username: this.cfg.username }),
        { mode: 0o600 },
      );
      await fs.chmod(this.tokenStorePath, 0o600);
    } catch (err) {
      this.log.warn(`Hive: could not persist refresh token: ${(err as Error).message}`);
    }
  }

  // ---- Device discovery ----------------------------------------------------

  /**
   * Bind handlers to the accessories restored from Homebridge's cache before
   * Hive has answered. Without them HomeKit serves the values cached at the
   * last shutdown as if they were live, and accepts writes that go nowhere;
   * with them every read reports No Response until the first poll lands.
   */
  private attachCachedHandlers(): void {
    for (const accessory of this.accessories) {
      const id: unknown = accessory.context.hiveId;
      if (typeof id !== 'string') {
        continue;
      }
      if (accessory.UUID === this.heatingUuid(id)) {
        this.handlers.set(id, new HiveHeatingAccessory(this, accessory, id));
      } else if (accessory.UUID === this.hotWaterUuid(id)) {
        this.handlers.set(
          id,
          new HiveHotWaterAccessory(this, accessory, id, this.hotWaterBoostMinutes),
        );
      }
    }
  }

  private async discoverDevices(): Promise<void> {
    let state: HiveState;
    try {
      state = await this.fetchState();
    } catch (err) {
      // Leaves `discovered` false so the next poll tries again — otherwise one
      // bad response at startup (a timeout, a Hive 5xx) would leave every later
      // poll with nowhere to deliver state.
      this.log.error(
        `Hive: failed to fetch devices: ${(err as Error).message}. ` +
          'Retrying on the next poll.',
      );
      return;
    }

    for (const zone of state.zones) {
      this.registerHeating(zone.id, zone.name);
      this.log.info(
        `Discovered heating zone "${zone.name}" ` +
          `(current ${zone.currentTemperature}°C, target ${zone.targetTemperature}°C, ` +
          `mode ${zone.mode}${zone.boosting ? ', boosting' : ''}` +
          `${zone.online ? '' : ', OFFLINE'}).`,
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
        this.handlers.delete(accessory.context.hiveId);
        const index = this.accessories.indexOf(accessory);
        if (index >= 0) {
          this.accessories.splice(index, 1);
        }
      }
    }

    // Seed initial values.
    this.applyState(state);

    // Matter registration is the last thing discoverDevices() does, and
    // bootstrap() only reaches startPolling() once it resolves — so an
    // exception here (a matter.js conformance rejection, a device-type shape
    // this Homebridge does not offer) must not escape, or a Matter-only problem
    // would leave the poll timer unarmed and freeze the plain HomeKit
    // accessories too.
    try {
      await this.matterPlatform?.register(state);
    } catch (err) {
      this.log.error(
        `Hive: Matter registration failed (${(err as Error).message}). ` +
          'HomeKit accessories are unaffected; please open a GitHub issue with ' +
          'your Homebridge version.',
      );
    }

    this.discovered = true;
  }

  private registerHeating(id: string, name: string): void {
    const accessory = this.platformAccessory(this.heatingUuid(id), id, name);
    if (!(this.handlers.get(id) instanceof HiveHeatingAccessory)) {
      this.handlers.set(id, new HiveHeatingAccessory(this, accessory, id));
    }
  }

  private registerHotWater(id: string, name: string): void {
    const accessory = this.platformAccessory(this.hotWaterUuid(id), id, name);
    if (!(this.handlers.get(id) instanceof HiveHotWaterAccessory)) {
      this.handlers.set(
        id,
        new HiveHotWaterAccessory(this, accessory, id, this.hotWaterBoostMinutes),
      );
    }
  }

  /** The cached accessory for `uuid`, registering a new one if there is none. */
  private platformAccessory(uuid: string, id: string, name: string): PlatformAccessory {
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
    return accessory;
  }

  private heatingUuid(id: string): string {
    return this.homebridgeApi.hap.uuid.generate(`hive-heating-${id}`);
  }

  private hotWaterUuid(id: string): string {
    return this.homebridgeApi.hap.uuid.generate(`hive-hotwater-${id}`);
  }

  // ---- Polling -------------------------------------------------------------

  private startPolling(): void {
    if (this.shuttingDown) {
      return;
    }
    this.pollTimer = setInterval(() => void this.pollOnce(), this.pollIntervalMs);
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
      if (!this.discovered) {
        // Startup discovery never completed. Retry it here rather than polling
        // into a handler map that is still empty.
        await this.discoverDevices();
        return;
      }
      this.applyState(await this.fetchState());
      if (this.failedPolls >= STALE_AFTER_FAILED_POLLS) {
        this.log.info('Hive: responding again; accessories are back to live state.');
      }
      this.failedPolls = 0;
    } catch (err) {
      this.log.debug(`Hive poll error: ${(err as Error).message}`);
      if (++this.failedPolls === STALE_AFTER_FAILED_POLLS) {
        this.markUnreachable(err as Error);
      }
    } finally {
      this.polling = false;
    }
  }

  /**
   * Report every accessory as unreachable after Hive has stopped answering.
   *
   * Hive's per-device `online` flag only covers a device dropping off Hive's
   * own network. When Hive itself is unreachable — or the session has been
   * revoked — the last values it sent would otherwise be served as live for as
   * long as the outage lasts. The next successful poll restores them.
   */
  private markUnreachable(cause: Error): void {
    this.log.warn(
      `Hive: no response for ${STALE_AFTER_FAILED_POLLS} polls in a row ` +
        `(${cause.message}); reporting accessories as unreachable until it recovers.`,
    );
    for (const handler of this.handlers.values()) {
      handler.markUnreachable();
    }
    this.matterPlatform?.markUnreachable().catch((err) =>
      this.log.debug(`Hive Matter reachability update failed: ${(err as Error).message}`),
    );
  }

  /**
   * Read Hive state, refreshing the session and retrying once if the token has
   * expired, rather than serving stale state until the next tick.
   */
  private async fetchState(): Promise<HiveState> {
    try {
      return await this.api!.getState();
    } catch (err) {
      if (!(err instanceof TokenExpiredError) || !(await this.refreshTokens())) {
        throw err;
      }
      return this.api!.getState();
    }
  }

  /**
   * Run a control command, refreshing the session and retrying once if the
   * token has expired — the same recovery reads get, so a command that lands
   * just after the id token ages out is not lost.
   */
  private async command(run: (api: HiveApi) => Promise<void>): Promise<void> {
    const api = this.api;
    if (!api) {
      // Unreachable in practice: HomeKit handlers refuse writes until a poll
      // has delivered state, and Matter handlers are only attached after
      // sign-in. Kept so a future ordering change fails loudly, not obscurely.
      throw new Error('Hive is not signed in yet — command ignored.');
    }
    try {
      await run(api);
    } catch (err) {
      if (!(err instanceof TokenExpiredError) || !(await this.refreshTokens())) {
        throw err;
      }
      await run(api);
    }
  }

  // ---- Control commands ----------------------------------------------------
  //
  // Accessories and the Matter layer go through these rather than HiveApi
  // directly, so every write gets the same expired-token recovery.

  setHeatingMode(id: string, mode: HiveMode): Promise<void> {
    return this.command((api) => api.setHeatingMode(id, mode));
  }

  /** `current` is the zone's latest state; see HiveApi.setHeatingTarget(). */
  setHeatingTarget(id: string, temp: number, current?: HiveHeatingZone): Promise<void> {
    return this.command((api) => api.setHeatingTarget(id, temp, current));
  }

  setHotWaterBoost(id: string, minutes: number): Promise<void> {
    return this.command((api) => api.setHotWaterBoost(id, minutes));
  }

  cancelHotWaterBoost(id: string, returnTo?: HiveMode): Promise<void> {
    return this.command((api) => api.cancelHotWaterBoost(id, returnTo));
  }

  /**
   * Schedule a one-off poll shortly after a control command, so HomeKit
   * reflects the confirmed device state without waiting for the next regular
   * poll. Multiple rapid calls collapse into a single refresh.
   */
  pollSoon(delayMs = 4000): void {
    clearTimeout(this.pollSoonTimer);
    if (this.shuttingDown) {
      return;
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

  /**
   * Refresh id/access tokens using the stored refresh token. Returns whether
   * the session is now usable, so callers can skip a retry that would only
   * repeat the same failure.
   *
   * Single-flight: a poll and a command that both hit a 401 share one refresh
   * rather than spending the refresh token twice.
   */
  refreshTokens(): Promise<boolean> {
    this.refreshing ??= this.refreshTokensOnce().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async refreshTokensOnce(): Promise<boolean> {
    if (!this.auth || !this.tokens) {
      return false;
    }
    try {
      this.tokens = await this.auth.refreshFromToken(this.tokens.refreshToken);
      await this.saveRefreshToken(this.tokens.refreshToken);
      this.authFailureReported = false;
      this.log.debug('Hive: tokens refreshed.');
      return true;
    } catch (err) {
      if (isTransientAuthError(err)) {
        // Hive or Cognito is unreachable, which says nothing about the session.
        // The next poll tries again, and a lasting outage is reported through
        // markUnreachable() rather than as a credentials problem.
        this.log.debug(`Hive: token refresh failed, will retry: ${(err as Error).message}`);
        return false;
      }
      const message =
        'Hive: token refresh failed. Re-authentication needed — ' +
        're-enter credentials and an SMS code in the config. ' +
        `(${(err as Error).message})`;
      // A rejected refresh token stays rejected, and polling continues in case
      // the failure was transient — so report it once at error level and keep
      // the rest at debug rather than filling the log every 15 seconds.
      if (this.authFailureReported) {
        this.log.debug(message);
      } else {
        this.authFailureReported = true;
        this.log.error(message);
      }
      return false;
    }
  }
}

/** Email addresses compare case-insensitively, and config fields pick up stray spaces. */
function normaliseUsername(username: string): string {
  return username.trim().toLowerCase();
}
