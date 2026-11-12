/**
 * HiveThermostatPlatform — the dynamic platform plugin entry point.
 *
 * Auth lifecycle (designed around Homebridge's static config UI):
 *   1. User enters username + password, saves, restarts.
 *   2. If the account has SMS 2FA, the platform logs a clear prompt and waits,
 *      watching config.json. The user reads the SMS, puts the code in the
 *      `smsCode` config field and saves — no restart needed, though the
 *      Homebridge UI asks for one after every save. Restarting does no harm:
 *      the waiting login is resumed (below).
 *
 *      Cognito accepts a code only for the login attempt that sent it, and
 *      every new login sends a new code. So the waiting challenge is stored,
 *      and a restart resumes it instead of logging in again; a code already in
 *      the config when a login began belongs to an older one and is ignored.
 *   3. On success the refresh token is persisted to disk; subsequent restarts
 *      silently refresh and never need the SMS field again. The user can clear
 *      smsCode afterwards.
 *   4. If Hive later rejects the session outright, the platform signs in again
 *      by itself, which may text a new code — step 2 again, without a restart.
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
  CODE_WATCH_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  MFA_CHALLENGE_MAX_AGE_MS,
  MIN_POLL_INTERVAL_MS,
  STALE_AFTER_FAILED_POLLS,
  STARTUP_RETRY_MAX_MS,
  STARTUP_RETRY_MIN_MS,
} from './settings';
import {
  HiveAuth,
  HiveAuthActionRequired,
  HiveDevice,
  HiveMfaChallenge,
  HiveSmsRequired,
  HiveTokens,
  isChallengeExpired,
  isTransientAuthError,
} from './hiveAuth';
import { HiveTimeoutError } from './timeout';
import {
  HiveApi,
  HiveHeatingType,
  HiveHeatingZone,
  HiveLight,
  HiveLightChange,
  HiveLightType,
  HiveMode,
  HivePlug,
  HiveSensor,
  HiveSensorType,
  HiveState,
  TokenExpiredError,
} from './hiveApi';
import { HiveHeatingAccessory } from './heatingAccessory';
import { HiveHotWaterAccessory } from './hotWaterAccessory';
import { HivePlugAccessory } from './plugAccessory';
import { HiveLightAccessory } from './lightAccessory';
import { HiveSensorAccessory } from './sensorAccessory';
import { HiveMatterPlatform } from './matterPlatform';

interface HiveConfig extends PlatformConfig {
  username?: string;
  password?: string;
  smsCode?: string;
  pollInterval?: number;
  hotWaterDurationMinutes?: number;
  enableMatter?: boolean;
  /** Each defaults to on; false leaves that kind of device out entirely. */
  enablePlugs?: boolean;
  enableLights?: boolean;
  enableSensors?: boolean;
}

type Handler =
  | HiveHeatingAccessory
  | HiveHotWaterAccessory
  | HivePlugAccessory
  | HiveLightAccessory
  | HiveSensorAccessory;

/** What `.hive-thermostat-tokens.json` holds. */
interface StoredTokens {
  refreshToken?: unknown;
  /** Absent in files written by 1.0.9 and earlier. */
  username?: unknown;
  /**
   * The Cognito device the refresh token is bound to; see HiveDevice. Absent
   * in files written by 1.2.0 and earlier, whose tokens therefore never
   * survived a restart.
   */
  device?: unknown;
}

/** What `.hive-thermostat-2fa.json` holds: a login waiting on its 2FA code. */
interface PendingChallenge {
  /** The configured account, so a challenge never crosses accounts. */
  username: string;
  challenge: HiveMfaChallenge;
  /** When the code was sent (ms since the epoch). */
  sentAt: number;
  /**
   * The code in the config when this login began. It was sent for an earlier
   * login, so it is never submitted to this one.
   */
  staleCode?: string;
}

/** What a usable token file yields. */
interface StoredSession {
  refreshToken: string;
  device?: HiveDevice;
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
  private readonly challengeStorePath: string;
  /** The login waiting on a 2FA code, if any. */
  private pending?: PendingChallenge;
  /** The last code submitted to `pending`, so a rejected one is not resent. */
  private lastTriedCode?: string;
  private codeWatchTimer?: NodeJS.Timeout;
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
   * Whether a failed Matter registration has already been reported, so one
   * that keeps failing is retried every poll without an error every poll.
   */
  private matterFailureReported = false;
  /** The refresh in flight, shared by every caller that hits a 401 meanwhile. */
  private refreshing?: Promise<boolean>;
  private readonly pollIntervalMs: number;
  private readonly hotWaterBoostMinutes: number;
  private readonly matterPlatform?: HiveMatterPlatform;

  /** Handlers keyed by hive product id, so polling can push updates. */
  private readonly handlers = new Map<string, Handler>();

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
          setHeatingMode: (zone, mode) => this.setHeatingMode(zone, mode),
          setHeatingTarget: (zone, temp) => this.setHeatingTarget(zone, temp),
          setHotWaterBoost: (id, minutes) => this.setHotWaterBoost(id, minutes),
          cancelHotWaterBoost: (id, returnTo) =>
            this.cancelHotWaterBoost(id, returnTo),
          setPlug: (id, on) => this.setPlug(id, on),
          setLight: (light, change) => this.setLight(light, change),
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

    this.challengeStorePath = path.join(
      this.homebridgeApi.user.storagePath(),
      '.hive-thermostat-2fa.json',
    );

    const configured = !!this.cfg.username && !!this.cfg.password;
    if (!configured) {
      this.log.error(
        'Hive username and password are required. Set them in the plugin config.',
      );
    }

    this.homebridgeApi.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      // Even with no way to sign in, cached accessories must not pass off the
      // values from the last shutdown as live.
      this.attachCachedHandlers();
      if (configured) {
        this.startup();
      }
    });

    this.homebridgeApi.on(APIEvent.SHUTDOWN, () => {
      this.shuttingDown = true;
      clearInterval(this.pollTimer);
      clearTimeout(this.pollSoonTimer);
      clearTimeout(this.startupRetryTimer);
      clearTimeout(this.codeWatchTimer);
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
    // Tokens are already in hand when a 2FA code has just been accepted, or
    // when an earlier attempt signed in and then failed to reach Hive.
    if (!this.tokens && !(await this.authenticate())) {
      return; // waiting on the user to supply an SMS code
    }

    await this.saveRefreshToken(this.tokens!.refreshToken);
    this.log.debug(
      `Hive: session stored ${this.auth.device() ? 'with' : 'without'} a Cognito device.`,
    );

    // Also reached when signing in again after Hive rejected the session (see
    // signOut()), with discovery done and polling already running.
    this.api ??= new HiveApi(() => {
      if (!this.tokens) {
        throw new Error('Hive is signed out; waiting to sign in again.');
      }
      return this.tokens.idToken;
    }, this.log);

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
        this.tokens = await auth.refreshFromToken(stored.refreshToken, stored.device);
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

    // 2. A login from before a restart may still be waiting on its code.
    //    Logging in again would text a new code and void the one the user
    //    may be reading right now.
    const pending = await this.loadChallenge();
    if (pending) {
      this.pending = pending;
      const sent = new Date(pending.sentAt).toLocaleTimeString();
      this.log.info(`Hive: still waiting for the 2FA code sent at ${sent}.`);
      return this.awaitSmsCode();
    }

    // 3. No usable token — do a fresh login (which may need SMS 2FA). A code
    //    already in the config was sent for some earlier login. The config as
    //    saved now, since this can run long after startup (see signOut()).
    const configured = await this.readConfiguredCode();
    if (await this.freshLogin(normaliseCode(configured ?? this.cfg.smsCode))) {
      return true;
    }
    return this.awaitSmsCode();
  }

  /**
   * Log in with the password. Resolves true when signed in, false when Hive
   * texted a 2FA code — the challenge is then stored as `pending`.
   *
   * `staleCode` is a code the user has already entered for an earlier login,
   * never to be submitted to this one.
   */
  private async freshLogin(staleCode?: string): Promise<boolean> {
    try {
      this.tokens = await this.auth!.login();
      this.log.info('Hive: logged in (no 2FA required).');
      return true;
    } catch (err) {
      if (err instanceof HiveTimeoutError) {
        // Unlike a network failure, a timeout does not mean the request went
        // unanswered: Cognito may have accepted the password and texted a 2FA
        // code. Retrying would text another one at every backoff step.
        throw new HiveAuthActionRequired(
          `${err.message} Not retried automatically, since each attempt can ` +
            'send a new 2FA code; restart Homebridge to try again.',
        );
      }
      if (!(err instanceof HiveSmsRequired)) {
        throw err;
      }
      this.pending = {
        username: this.cfg.username!,
        challenge: err.challenge,
        sentAt: Date.now(),
        staleCode,
      };
      this.lastTriedCode = undefined;
      await this.saveChallenge(this.pending);
      const to = err.challenge.destination ? ` to ${err.challenge.destination}` : '';
      this.log.warn(
        '============================================================\n' +
          'Hive requires two-factor authentication.\n' +
          `A code has been sent${to}. Enter it in the plugin's\n` +
          '"2FA Code" field and click Save. The plugin picks the code up\n' +
          'within a few seconds. Homebridge UI will then say a restart is\n' +
          'required: there is no need, so you can click Close. (Restarting\n' +
          'does no harm either; the plugin carries on with the same code.)\n' +
          'Codes expire after a few minutes.\n' +
          '============================================================',
      );
      return false;
    }
  }

  /**
   * Try the configured code against the pending challenge, and if it is not
   * accepted, watch config.json for one. Resolves true when signed in.
   */
  private async awaitSmsCode(): Promise<boolean> {
    if (await this.trySmsCode(this.cfg.smsCode)) {
      return true;
    }
    this.watchConfigForCode();
    return false;
  }

  /**
   * Submit `code` to the pending challenge, unless it is empty, belongs to an
   * earlier login, or was already tried. Resolves true when signed in.
   */
  private async trySmsCode(entered: string | undefined): Promise<boolean> {
    const pending = this.pending!;
    const code = normaliseCode(entered);
    if (!code || code === pending.staleCode || code === this.lastTriedCode) {
      return false;
    }
    this.lastTriedCode = code;

    try {
      this.tokens = await this.auth!.submitSms(code, pending.challenge);
    } catch (err) {
      const message = (err as Error).message;
      if (isTransientAuthError(err)) {
        // Submitting again sends no SMS, so the next look at the config
        // tries the same code again.
        this.lastTriedCode = undefined;
        this.log.warn(`Hive: could not submit the 2FA code (${message}). Trying again shortly.`);
        return false;
      }
      if (isChallengeExpired(err)) {
        // Only a new login can go on, and it sends a new code. The user has
        // just entered one, so they are there to read it.
        this.log.warn(
          `Hive: that 2FA code has expired (${message}). Sending a new one.`,
        );
        return this.freshLogin(code);
      }
      // CodeMismatchException, or anything else about the code itself: the
      // challenge still stands, so wait for a corrected code.
      this.log.error(
        `Hive: 2FA code rejected (${message}). Check it against the latest ` +
          'SMS from Hive, enter it in the "2FA Code" field and click Save.',
      );
      return false;
    }

    this.pending = undefined;
    this.lastTriedCode = undefined;
    await fs.unlink(this.challengeStorePath).catch(() => {
      /* already gone */
    });
    this.log.info('Hive: 2FA accepted. You can now clear the 2FA Code field.');
    return true;
  }

  /**
   * Look in config.json every few seconds for a new 2FA code, so the user can
   * enter it and save without restarting — a restart is just more time for
   * the code to expire. Signs in and carries on with startup once accepted.
   */
  private watchConfigForCode(): void {
    if (this.codeWatchTimer || this.shuttingDown) {
      return;
    }
    const tick = async () => {
      this.codeWatchTimer = undefined;
      if (this.shuttingDown || !this.pending) {
        return;
      }
      let signedIn = false;
      try {
        signedIn = await this.trySmsCode(await this.readConfiguredCode());
      } catch (err) {
        // Only the new login started for an expired code can throw here. If
        // it never reached Cognito, nothing was sent: forget the code was
        // tried, so the next look finds the challenge still expired and
        // starts that login again.
        if (!isTransientAuthError(err)) {
          this.log.error(`Hive startup failed: ${(err as Error).message}`);
          return;
        }
        this.lastTriedCode = undefined;
        this.log.warn(
          `Hive: could not start a new sign-in (${(err as Error).message}). Trying again shortly.`,
        );
      }
      if (signedIn) {
        this.startup();
      } else if (!this.shuttingDown) {
        this.codeWatchTimer = setTimeout(() => void tick(), CODE_WATCH_INTERVAL_MS);
      }
    };
    this.codeWatchTimer = setTimeout(() => void tick(), CODE_WATCH_INTERVAL_MS);
  }

  /** The smsCode saved for this account in config.json right now. */
  private async readConfiguredCode(): Promise<string | undefined> {
    let config: { platforms?: unknown };
    try {
      config = JSON.parse(await fs.readFile(this.homebridgeApi.user.configPath(), 'utf8'));
    } catch {
      return undefined; // unreadable, or caught mid-save; look again next time
    }
    if (!Array.isArray(config.platforms)) {
      return undefined;
    }
    const account = normaliseUsername(this.cfg.username!);
    const mine = (config.platforms as Record<string, unknown>[]).find(
      (p) =>
        (p?.platform === PLATFORM_NAME || p?.platform === `${PLUGIN_NAME}.${PLATFORM_NAME}`) &&
        typeof p.username === 'string' &&
        normaliseUsername(p.username) === account,
    );
    return typeof mine?.smsCode === 'string' ? mine.smsCode : undefined;
  }

  /** The stored challenge, if it is this account's and may still be open. */
  private async loadChallenge(): Promise<PendingChallenge | undefined> {
    let stored: Partial<PendingChallenge>;
    try {
      stored = JSON.parse(await fs.readFile(this.challengeStorePath, 'utf8'));
    } catch {
      return undefined;
    }
    const challenge = stored.challenge as Partial<HiveMfaChallenge> | undefined;
    if (
      typeof stored.username !== 'string' ||
      normaliseUsername(stored.username) !== normaliseUsername(this.cfg.username!) ||
      typeof stored.sentAt !== 'number' ||
      Date.now() - stored.sentAt > MFA_CHALLENGE_MAX_AGE_MS ||
      typeof challenge?.username !== 'string' ||
      typeof challenge.session !== 'string' ||
      (challenge.type !== 'SMS_MFA' && challenge.type !== 'SOFTWARE_TOKEN_MFA')
    ) {
      return undefined;
    }
    return {
      username: stored.username,
      challenge: challenge as HiveMfaChallenge,
      sentAt: stored.sentAt,
      staleCode: typeof stored.staleCode === 'string' ? stored.staleCode : undefined,
    };
  }

  /** Store the challenge so a restart can resume it; readable by Homebridge alone. */
  private async saveChallenge(pending: PendingChallenge): Promise<void> {
    try {
      await writePrivateFile(this.challengeStorePath, JSON.stringify(pending));
    } catch (err) {
      this.log.warn(`Hive: could not store the 2FA challenge: ${(err as Error).message}`);
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
  private async loadRefreshToken(): Promise<StoredSession | undefined> {
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
    return { refreshToken: stored.refreshToken, device: parseDevice(stored.device) };
  }

  /**
   * Store the refresh token with the Cognito device it is bound to, without
   * which Hive rejects it after a restart (see HiveDevice). The file holds
   * credentials, so it is readable by the Homebridge user alone.
   */
  private async saveRefreshToken(refreshToken: string): Promise<void> {
    try {
      await writePrivateFile(
        this.tokenStorePath,
        JSON.stringify({
          refreshToken,
          username: this.cfg.username,
          device: this.auth?.device(),
        }),
      );
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
        this.handlers.set(
          id,
          new HiveHeatingAccessory(this, accessory, id, heatingTypeOf(accessory)),
        );
      } else if (accessory.UUID === this.hotWaterUuid(id)) {
        this.handlers.set(
          id,
          new HiveHotWaterAccessory(this, accessory, id, this.hotWaterBoostMinutes),
        );
      } else if (accessory.UUID === this.plugUuid(id)) {
        this.handlers.set(id, new HivePlugAccessory(this, accessory, id));
      } else if (accessory.UUID === this.lightUuid(id) && isLightType(accessory.context.hiveType)) {
        this.handlers.set(
          id,
          new HiveLightAccessory(this, accessory, id, accessory.context.hiveType),
        );
      } else if (accessory.UUID === this.sensorUuid(id) && isSensorType(accessory.context.hiveType)) {
        this.handlers.set(
          id,
          new HiveSensorAccessory(this, accessory, id, accessory.context.hiveType),
        );
      }
    }
  }

  private async discoverDevices(): Promise<void> {
    let reported: HiveState;
    try {
      reported = await this.fetchState();
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
    const state = this.enabledOnly(reported);

    for (const zone of state.zones) {
      this.registerHeating(zone);
      const valve = zone.type === 'trvcontrol';
      this.log.info(
        `Discovered ${valve ? 'radiator valve' : 'heating zone'} "${zone.name}" ` +
          `(current ${zone.currentTemperature}°C, target ${zone.targetTemperature}°C, ` +
          `mode ${zone.mode}${zone.boosting ? ', boosting' : ''}` +
          `${zone.battery !== undefined ? `, battery ${zone.battery}%` : ''}` +
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

    for (const plug of state.plugs ?? []) {
      this.registerPlug(plug);
      this.log.info(
        `Discovered plug "${plug.name}" (${plug.on ? 'on' : 'off'}` +
          `${plug.online ? '' : ', OFFLINE'}).`,
      );
    }
    for (const light of state.lights ?? []) {
      this.registerLight(light);
      this.log.info(
        `Discovered light "${light.name}" (${light.type}, ` +
          `${light.on ? `on at ${light.brightness}%` : 'off'}${light.online ? '' : ', OFFLINE'}).`,
      );
    }
    for (const sensor of state.sensors ?? []) {
      this.registerSensor(sensor);
      const motion = sensor.type === 'motionsensor';
      this.log.info(
        `Discovered ${motion ? 'motion sensor' : 'window/door sensor'} "${sensor.name}" (` +
          (motion
            ? sensor.triggered ? 'motion' : 'no motion'
            : sensor.triggered ? 'open' : 'closed') +
          `${sensor.battery !== undefined ? `, battery ${sensor.battery}%` : ''}` +
          `${sensor.online ? '' : ', OFFLINE'}).`,
      );
    }

    // An answer with nothing in it at all is far more likely to be Hive having
    // a bad moment than an account emptied of every device — and pruning on it
    // would delete every accessory, taking the user's rooms, scenes and
    // automations with them. Keep them: they report No Response until Hive
    // lists them again.
    const hiveReportedNothing = allProducts(reported).length === 0;
    if (hiveReportedNothing) {
      this.log.warn(
        'Hive: no supported devices found on this account. Existing accessories ' +
          'are kept, in case this is a passing fault at Hive. If you expected ' +
          'devices here, please open a GitHub issue with your Homebridge log.',
      );
    }

    // Remove stale accessories no longer present on the account.
    const liveIds = new Set(allProducts(state).map((p) => p.id));
    const stale = hiveReportedNothing
      ? []
      : this.accessories.filter((a) => !liveIds.has(a.context.hiveId));
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

    if (!hiveReportedNothing) {
      await this.registerMatter(state);
    }

    this.discovered = true;
  }

  /**
   * Register the Matter accessories, or retry whatever did not register last
   * time; a no-op once everything has.
   *
   * Never throws: bootstrap() only reaches startPolling() once discovery
   * resolves, so a Matter-only problem (a matter.js conformance rejection, a
   * device-type shape this Homebridge does not offer) must not escape, or it
   * would leave the poll timer unarmed and freeze the HomeKit accessories too.
   * Some failures pass on their own — Homebridge refuses registrations while
   * its Matter server is still starting — so every poll tries again.
   */
  private async registerMatter(state: HiveState): Promise<void> {
    if (!this.matterPlatform?.needsRegistration) {
      return;
    }
    try {
      await this.matterPlatform.register(state);
      this.matterFailureReported = false;
    } catch (err) {
      const message =
        `Hive: Matter registration failed (${(err as Error).message}). ` +
        'HomeKit accessories are unaffected; retrying on the next poll.';
      if (this.matterFailureReported) {
        this.log.debug(message);
      } else {
        this.matterFailureReported = true;
        this.log.error(
          `${message} If this keeps happening, please open a GitHub issue ` +
            'with your Homebridge version.',
        );
      }
    }
  }

  /**
   * Heating zones and radiator valves share a handler and a UUID namespace —
   * Hive product ids are unique across both. The product type is kept in the
   * accessory's context so a cached accessory is rebuilt as the right kind
   * before Hive has answered.
   */
  private registerHeating(zone: HiveHeatingZone): void {
    const { id, name, type } = zone;
    const accessory = this.platformAccessory(this.heatingUuid(id), id, name, { hiveType: type });
    if (!(this.handlers.get(id) instanceof HiveHeatingAccessory)) {
      this.handlers.set(id, new HiveHeatingAccessory(this, accessory, id, type));
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

  /**
   * The cached accessory for `uuid`, registering a new one if there is none.
   * `context` is stored alongside the Hive id and kept up to date.
   */
  private platformAccessory(
    uuid: string,
    id: string,
    name: string,
    context: Record<string, string> = {},
  ): PlatformAccessory {
    let accessory = this.accessories.find((a) => a.UUID === uuid);
    if (!accessory) {
      accessory = new this.homebridgeApi.platformAccessory(name, uuid);
      Object.assign(accessory.context, context, { hiveId: id });
      this.homebridgeApi.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      // configureAccessory() only fires for accessories restored from cache, so
      // newly created ones have to be tracked here.
      this.accessories.push(accessory);
      return accessory;
    }
    const contextChanged = Object.entries(context).some(
      ([key, value]) => accessory!.context[key] !== value,
    );
    if (accessory.displayName !== name || contextChanged) {
      // Keep the cached accessory in sync with Hive's name and our context.
      accessory.displayName = name;
      Object.assign(accessory.context, context);
      this.homebridgeApi.updatePlatformAccessories([accessory]);
    }
    return accessory;
  }

  private registerPlug(plug: HivePlug): void {
    const accessory = this.platformAccessory(this.plugUuid(plug.id), plug.id, plug.name, {
      hiveType: plug.type,
    });
    if (!(this.handlers.get(plug.id) instanceof HivePlugAccessory)) {
      this.handlers.set(plug.id, new HivePlugAccessory(this, accessory, plug.id));
    }
  }

  private registerLight(light: HiveLight): void {
    const accessory = this.platformAccessory(this.lightUuid(light.id), light.id, light.name, {
      hiveType: light.type,
    });
    if (!(this.handlers.get(light.id) instanceof HiveLightAccessory)) {
      this.handlers.set(light.id, new HiveLightAccessory(this, accessory, light.id, light.type));
    }
  }

  private registerSensor(sensor: HiveSensor): void {
    const accessory = this.platformAccessory(this.sensorUuid(sensor.id), sensor.id, sensor.name, {
      hiveType: sensor.type,
    });
    if (!(this.handlers.get(sensor.id) instanceof HiveSensorAccessory)) {
      this.handlers.set(sensor.id, new HiveSensorAccessory(this, accessory, sensor.id, sensor.type));
    }
  }

  private plugUuid(id: string): string {
    return this.homebridgeApi.hap.uuid.generate(`hive-plug-${id}`);
  }

  private lightUuid(id: string): string {
    return this.homebridgeApi.hap.uuid.generate(`hive-light-${id}`);
  }

  private sensorUuid(id: string): string {
    return this.homebridgeApi.hap.uuid.generate(`hive-sensor-${id}`);
  }

  private heatingUuid(id: string): string {
    return this.homebridgeApi.hap.uuid.generate(`hive-heating-${id}`);
  }

  private hotWaterUuid(id: string): string {
    return this.homebridgeApi.hap.uuid.generate(`hive-hotwater-${id}`);
  }

  // ---- Polling -------------------------------------------------------------

  private startPolling(): void {
    // Already running when this is a sign-in after Hive rejected the session.
    if (this.shuttingDown || this.pollTimer) {
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
    // Signed out after Hive rejected the session: nothing to read with until
    // the new sign-in completes, and the accessories already say so.
    if (this.polling || !this.tokens) {
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
      const reported = await this.fetchState();
      const state = this.enabledOnly(reported);
      this.applyState(state);
      if (this.failedPolls >= STALE_AFTER_FAILED_POLLS) {
        this.log.info('Hive: responding again; accessories are back to live state.');
      }
      this.failedPolls = 0;
      if (allProducts(reported).length > 0) {
        await this.registerMatter(state);
      }
    } catch (err) {
      this.log.debug(`Hive poll error: ${(err as Error).message}`);
      if (++this.failedPolls === STALE_AFTER_FAILED_POLLS) {
        this.markUnreachable(
          `Hive: no response for ${STALE_AFTER_FAILED_POLLS} polls in a row ` +
            `(${(err as Error).message}); reporting accessories as unreachable until it recovers.`,
        );
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
  private markUnreachable(message: string): void {
    this.log.warn(message);
    for (const handler of this.handlers.values()) {
      handler.markUnreachable();
    }
    this.matterPlatform?.markUnreachable().catch((err) =>
      this.log.debug(`Hive Matter reachability update failed: ${(err as Error).message}`),
    );
  }

  /**
   * Read Hive state, refreshing the session and retrying once if the token has
   * expired, rather than serving stale state until the next tick. Every kind
   * of device is included; see enabledOnly().
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
   * Drop the kinds of device the config turns off. Everything downstream then
   * treats them as gone, so turning a kind off also removes its accessories.
   */
  private enabledOnly(state: HiveState): HiveState {
    return {
      zones: state.zones,
      hotWater: state.hotWater,
      plugs: this.cfg.enablePlugs === false ? [] : state.plugs ?? [],
      lights: this.cfg.enableLights === false ? [] : state.lights ?? [],
      sensors: this.cfg.enableSensors === false ? [] : state.sensors ?? [],
    };
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

  /** `zone` is the zone's latest state, which says which node to write. */
  setHeatingMode(zone: HiveHeatingZone, mode: HiveMode): Promise<void> {
    return this.command((api) => api.setHeatingMode(zone, mode));
  }

  /** `zone` is the zone's latest state; see HiveApi.setHeatingTarget(). */
  setHeatingTarget(zone: HiveHeatingZone, temp: number): Promise<void> {
    return this.command((api) => api.setHeatingTarget(zone, temp));
  }

  setHotWaterBoost(id: string, minutes: number): Promise<void> {
    return this.command((api) => api.setHotWaterBoost(id, minutes));
  }

  cancelHotWaterBoost(id: string, returnTo?: HiveMode): Promise<void> {
    return this.command((api) => api.cancelHotWaterBoost(id, returnTo));
  }

  setPlug(id: string, on: boolean): Promise<void> {
    return this.command((api) => api.setPlug(id, on));
  }

  setLight(light: Pick<HiveLight, 'id' | 'type'>, change: HiveLightChange): Promise<void> {
    return this.command((api) => api.setLight(light, change));
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
    // A product Hive no longer reports has nothing live to show: report it
    // unreachable, rather than leave whatever it last had on display.
    const reported = new Set(allProducts(state).map((p) => p.id));
    for (const [id, handler] of this.handlers) {
      if (!reported.has(id)) {
        handler.markUnreachable();
      }
    }
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
    for (const plug of state.plugs ?? []) {
      const h = this.handlers.get(plug.id);
      if (h instanceof HivePlugAccessory) {
        h.update(plug);
      }
      this.matterPlatform?.updatePlug(plug).catch((err) =>
        this.log.debug(`Hive Matter plug update failed: ${(err as Error).message}`),
      );
    }
    for (const light of state.lights ?? []) {
      const h = this.handlers.get(light.id);
      if (h instanceof HiveLightAccessory) {
        h.update(light);
      }
      this.matterPlatform?.updateLight(light).catch((err) =>
        this.log.debug(`Hive Matter light update failed: ${(err as Error).message}`),
      );
    }
    for (const sensor of state.sensors ?? []) {
      const h = this.handlers.get(sensor.id);
      if (h instanceof HiveSensorAccessory) {
        h.update(sensor);
      }
      this.matterPlatform?.updateSensor(sensor).catch((err) =>
        this.log.debug(`Hive Matter sensor update failed: ${(err as Error).message}`),
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
      await this.signOut(err as Error);
      return false;
    }
  }

  /**
   * Hive has rejected the session outright, so it will never work again: sign
   * in afresh, as a restart would. Without 2FA that is silent; with it, a code
   * is texted and the user enters it as at setup — no restart needed.
   *
   * Until then polls are skipped and the accessories report No Response,
   * rather than asking Cognito every poll to honour a token it has refused.
   * The stored token goes too, so a restart meanwhile does not try it again.
   */
  private async signOut(cause: Error): Promise<void> {
    if (!this.tokens) {
      return;
    }
    this.tokens = undefined;
    this.failedPolls = STALE_AFTER_FAILED_POLLS;
    this.markUnreachable(
      `Hive: the session was rejected (${cause.message}); signing in again. ` +
        'If Hive texts a 2FA code, enter it in the "2FA Code" field and click Save.',
    );
    await fs.unlink(this.tokenStorePath).catch(() => {
      /* already gone */
    });
    this.startup();
  }
}

/**
 * Write a file only the Homebridge user can read, replacing it in one step: a
 * crash or power cut mid-write leaves the old file whole rather than a
 * truncated one, which for the session would cost a new SMS sign-in.
 */
async function writePrivateFile(file: string, data: string): Promise<void> {
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, data, { mode: 0o600 });
  await fs.chmod(temp, 0o600);
  await fs.rename(temp, file);
}

/** Every product in a state, of every kind. */
function allProducts(state: HiveState): { id: string }[] {
  return [
    ...state.zones,
    ...state.hotWater,
    ...(state.plugs ?? []),
    ...(state.lights ?? []),
    ...(state.sensors ?? []),
  ];
}

function isLightType(value: unknown): value is HiveLightType {
  return value === 'warmwhitelight' || value === 'tuneablelight' || value === 'colourtuneablelight';
}

function isSensorType(value: unknown): value is HiveSensorType {
  return value === 'motionsensor' || value === 'contactsensor';
}

/** A stored device, if the file holds a complete one. */
function parseDevice(value: unknown): HiveDevice | undefined {
  const device = value as Partial<Record<keyof HiveDevice, unknown>> | null | undefined;
  if (
    typeof device?.username === 'string' &&
    typeof device.key === 'string' &&
    typeof device.groupKey === 'string' &&
    typeof device.password === 'string'
  ) {
    return {
      username: device.username,
      key: device.key,
      groupKey: device.groupKey,
      password: device.password,
    };
  }
  return undefined;
}

/**
 * The Hive product type recorded on a heating accessory. Accessories cached
 * before radiator valves were supported carry none, and are all heating zones.
 */
function heatingTypeOf(accessory: PlatformAccessory): HiveHeatingType {
  return accessory.context.hiveType === 'trvcontrol' ? 'trvcontrol' : 'heating';
}

/** Email addresses compare case-insensitively, and config fields pick up stray spaces. */
function normaliseUsername(username: string): string {
  return username.trim().toLowerCase();
}

/** A 2FA code as typed, without the spaces people paste in with it. */
function normaliseCode(code: unknown): string | undefined {
  return typeof code === 'string' ? code.replace(/\s+/g, '') || undefined : undefined;
}
