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
import fetch from 'node-fetch';
import type { Logger } from 'homebridge';
import { HIVE_URLS } from './settings';

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

export class HiveAuth {
  private poolConfig?: PoolConfig;
  private userPool?: CognitoUserPool;
  private cognitoUser?: CognitoUser;
  private session?: CognitoUserSession;

  /** Pending MFA continuation captured between login() and submitSms(). */
  private mfaCallback?: {
    resolve: (s: CognitoUserSession) => void;
    reject: (e: Error) => void;
    user: CognitoUser;
  };

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

    const res = await fetch(HIVE_URLS.sso, {
      headers: {
        // Hive's edge rejects requests without a normal browser UA.
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      },
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

    const session = await new Promise<CognitoUserSession>((resolve, reject) => {
      this.cognitoUser!.authenticateUser(authDetails, {
        onSuccess: (s) => resolve(s),
        onFailure: (err) => reject(err),
        // Hive uses SMS_MFA. Capture the continuation so submitSms() can
        // complete it.
        totpRequired: () => {
          this.mfaCallback = { resolve, reject, user: this.cognitoUser! };
          reject(new HiveSmsRequired());
        },
        mfaRequired: () => {
          this.mfaCallback = { resolve, reject, user: this.cognitoUser! };
          reject(new HiveSmsRequired());
        },
      });
    });

    this.session = session;
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

    const session = await new Promise<CognitoUserSession>((resolve, reject) => {
      this.cognitoUser!.sendMFACode(
        code.trim(),
        {
          onSuccess: (s) => resolve(s),
          onFailure: (err) => reject(err),
        },
        'SMS_MFA',
      );
    });

    this.session = session;
    this.mfaCallback = undefined;
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

    const session = await new Promise<CognitoUserSession>((resolve, reject) => {
      this.cognitoUser!.refreshSession(token, (err, s) => {
        if (err) {
          reject(err);
        } else {
          resolve(s);
        }
      });
    });

    this.session = session;
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
