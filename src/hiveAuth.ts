/**
 * HiveAuth — handles AWS Cognito SRP authentication against Hive's user pool,
 * including one-time SMS 2FA, refresh-token persistence, and silent re-auth.
 *
 * The pool ID and public client ID are discovered at runtime from the Hive SSO
 * page, mirroring how pyhiveapi works, so we don't hardcode values that Hive
 * may rotate.
 */

import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserSession,
  CognitoRefreshToken,
} from 'amazon-cognito-identity-js';
import type { Logger } from 'homebridge';
import { HIVE_URLS, HIVE_USER_AGENT } from './settings';
import { fetchWithTimeout, withTimeout } from './timeout';

export interface HiveTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
}

interface PoolConfig {
  poolId: string;
  clientId: string;
}

/** Thrown when login needs an SMS 2FA code to proceed. */
export class HiveSmsRequired extends Error {
  constructor() {
    super('Hive login requires an SMS 2FA code.');
    this.name = 'HiveSmsRequired';
  }
}

/**
 * Thrown when Hive wants something only the account owner can do — set a new
 * password, set up MFA — so retrying without them changes nothing.
 */
export class HiveAuthActionRequired extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HiveAuthActionRequired';
  }
}

/**
 * The Cognito error codes that mean the service never gave a real answer.
 * Every other `…Exception` is a verdict on the account or the token, and
 * retrying it achieves nothing — or, for a wrong password, counts towards
 * Cognito's lockout.
 */
const TRANSIENT_COGNITO_CODES = new Set([
  'InternalErrorException',
  'ServiceUnavailableException',
  'ThrottlingException',
  'TooManyRequestsException',
]);

/**
 * Whether an authentication failure says nothing about the credentials — a
 * network failure, a timeout, a Cognito outage — so the same call is worth
 * repeating later.
 *
 * Cognito reports each of its own answers with an `…Exception` code. Anything
 * without one never reached a verdict: the SSO page did not load, the request
 * timed out, the connection dropped (`NetworkError`).
 */
export function isTransientAuthError(err: unknown): boolean {
  if (err instanceof HiveSmsRequired || err instanceof HiveAuthActionRequired) {
    return false;
  }
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string' && code.endsWith('Exception')) {
    return TRANSIENT_COGNITO_CODES.has(code);
  }
  return true;
}

export class HiveAuth {
  private poolConfig?: PoolConfig;
  private userPool?: CognitoUserPool;
  private cognitoUser?: CognitoUser;

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly log: Logger,
  ) {}

  /**
   * Discover the Cognito pool + client IDs from the Hive SSO page.
   * The first <script> tag sets window.HiveSSOPoolId and
   * window.HiveSSOPublicCognitoClientId.
   */
  private async discoverPool(): Promise<PoolConfig> {
    if (this.poolConfig) {
      return this.poolConfig;
    }

    const res = await fetchWithTimeout(HIVE_URLS.sso, {
      headers: { 'User-Agent': HIVE_USER_AGENT },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch Hive SSO config: HTTP ${res.status}`);
    }

    const html = await res.text();

    const poolMatch = html.match(/HiveSSOPoolId\s*=\s*["']([^"']+)["']/);
    const clientMatch = html.match(
      /HiveSSOPublicCognitoClientId\s*=\s*["']([^"']+)["']/,
    );

    if (!poolMatch || !clientMatch) {
      throw new Error(
        'Could not parse Cognito pool/client IDs from Hive SSO page. ' +
          'Hive may have changed their login page format.',
      );
    }

    this.poolConfig = {
      poolId: poolMatch[1],
      clientId: clientMatch[1],
    };
    this.log.debug(`Discovered Hive Cognito pool: ${this.poolConfig.poolId}`);
    return this.poolConfig;
  }

  private async ensurePool(): Promise<CognitoUserPool> {
    if (this.userPool) {
      return this.userPool;
    }
    const cfg = await this.discoverPool();
    this.userPool = new CognitoUserPool({
      UserPoolId: cfg.poolId,
      ClientId: cfg.clientId,
    });
    return this.userPool;
  }

  /**
   * Begin authentication. Resolves with tokens on success.
   * If the account has SMS MFA enabled, throws HiveSmsRequired — the caller
   * should then call submitSms() with the code.
   */
  async login(): Promise<HiveTokens> {
    const pool = await this.ensurePool();

    this.cognitoUser = new CognitoUser({
      Username: this.username,
      Pool: pool,
    });
    // SRP requires USER_SRP_AUTH; the SDK does this by default.

    const authDetails = new AuthenticationDetails({
      Username: this.username,
      Password: this.password,
    });

    const session = await withTimeout(new Promise<CognitoUserSession>((resolve, reject) => {
      this.cognitoUser!.authenticateUser(authDetails, {
        onSuccess: (s) => resolve(s),
        onFailure: (err) => reject(err),
        // Hive uses SMS_MFA. submitSms() completes the challenge via
        // cognitoUser.sendMFACode().
        totpRequired: () => reject(new HiveSmsRequired()),
        mfaRequired: () => reject(new HiveSmsRequired()),
        // Cognito settles authenticateUser through exactly one callback. Any
        // challenge we don't provide a handler for would leave this promise
        // pending forever and hang Homebridge startup with no explanation, so
        // reject with something the user can act on instead.
        newPasswordRequired: () =>
          reject(
            new HiveAuthActionRequired(
              'Hive requires a new password to be set. Sign in at ' +
                'sso.hivehome.com, complete the password change, then update ' +
                'the plugin config.',
            ),
          ),
        mfaSetup: () =>
          reject(
            new HiveAuthActionRequired(
              'Hive requires two-factor authentication to be set up. Complete ' +
                'MFA setup at sso.hivehome.com, then restart Homebridge.',
            ),
          ),
        selectMFAType: () =>
          reject(
            new HiveAuthActionRequired(
              'Hive asked which MFA method to use, which this plugin cannot ' +
                'answer. Set SMS as the default MFA method in your Hive account.',
            ),
          ),
        customChallenge: () =>
          reject(
            new HiveAuthActionRequired(
              'Hive returned an unsupported custom login challenge. Please open ' +
                'a GitHub issue with your Homebridge log.',
            ),
          ),
      });
    }), 'Hive login');

    return this.tokensFromSession(session);
  }

  /**
   * Complete an MFA challenge with the SMS code the user received.
   * Only valid immediately after login() threw HiveSmsRequired.
   */
  async submitSms(code: string): Promise<HiveTokens> {
    if (!this.cognitoUser) {
      throw new Error('submitSms called before login.');
    }

    const session = await withTimeout(new Promise<CognitoUserSession>((resolve, reject) => {
      this.cognitoUser!.sendMFACode(
        code.trim(),
        {
          onSuccess: (s) => resolve(s),
          onFailure: (err) => reject(err),
        },
        'SMS_MFA',
      );
    }), 'Hive 2FA verification');

    return this.tokensFromSession(session);
  }

  /**
   * Restore a session from a previously stored refresh token, getting fresh
   * id/access tokens without any user interaction.
   */
  async refreshFromToken(refreshToken: string): Promise<HiveTokens> {
    const pool = await this.ensurePool();
    this.cognitoUser = new CognitoUser({ Username: this.username, Pool: pool });

    const token = new CognitoRefreshToken({ RefreshToken: refreshToken });

    const session = await withTimeout(new Promise<CognitoUserSession>((resolve, reject) => {
      this.cognitoUser!.refreshSession(token, (err, s) => {
        if (err) {
          reject(err);
        } else {
          resolve(s);
        }
      });
    }), 'Hive session refresh');

    return this.tokensFromSession(session);
  }

  private tokensFromSession(session: CognitoUserSession): HiveTokens {
    return {
      idToken: session.getIdToken().getJwtToken(),
      accessToken: session.getAccessToken().getJwtToken(),
      refreshToken: session.getRefreshToken().getToken(),
    };
  }
}
