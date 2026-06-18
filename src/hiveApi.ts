/**
 * HiveApi — thin client over Hive's beekeeper API.
 *
 * Responsibilities:
 *   - GET /nodes/all  → parse heating zones + hot water into a normalised shape
 *   - POST /nodes/{type}/{id} → write mode / target temperature / boost
 *
 * Auth is via the Cognito IdToken in the `authorization` header. Token refresh
 * is handled by the caller (the platform), which passes a getter so a freshly
 * refreshed token is always used.
 */

import type { Logger } from 'homebridge';
import { HIVE_URLS } from './settings';
import { fetchWithTimeout } from './fetchWithTimeout';

export type HiveMode = 'SCHEDULE' | 'MANUAL' | 'OFF' | 'BOOST';

export interface HiveHeatingZone {
  id: string;
  type: 'heating';
  name: string;
  online: boolean;
  currentTemperature: number;
  targetTemperature: number;
  mode: HiveMode;
  /** Whether the boiler is actively calling for heat right now. */
  heating: boolean;
}

export interface HiveHotWater {
  id: string;
  type: 'hotwater';
  name: string;
  online: boolean;
  mode: HiveMode;
  /** Whether hot water is currently on. */
  on: boolean;
  /** Whether a manual boost is currently active. */
  boosting: boolean;
  /** The mode to return to when a boost is cancelled. */
  previousMode: HiveMode;
}

export interface HiveState {
  zones: HiveHeatingZone[];
  hotWater: HiveHotWater[];
}

export class HiveApi {
  constructor(
    private readonly getIdToken: () => string,
    private readonly log: Logger,
  ) {}

  private headers() {
    return {
      'content-type': 'application/json',
      'accept': 'application/json',
      'authorization': this.getIdToken(),
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    };
  }

  /** Fetch and normalise all heating + hot water products. */
  async getState(): Promise<HiveState> {
    const res = await fetchWithTimeout(HIVE_URLS.nodesAll, {
      headers: this.headers(),
    });
    if (res.status === 401) {
      throw new TokenExpiredError();
    }
    if (!res.ok) {
      throw new Error(`Hive nodes/all failed: HTTP ${res.status}`);
    }

    const body = (await res.json()) as any;
    const products: any[] = body.products ?? [];
    const devices: any[] = body.devices ?? [];

    // Online status lives on the physical device, not the product. Build a
    // lookup of deviceId -> online, so a product can resolve it via `parent`.
    const onlineByDevice = new Map<string, boolean>();
    for (const d of devices) {
      onlineByDevice.set(d.id, d.props?.online !== false);
    }

    const resolveOnline = (p: any): boolean => {
      // A product's `parent` is the device id. Fall back to true if unknown
      // rather than wrongly flagging No Response.
      if (p.parent && onlineByDevice.has(p.parent)) {
        return onlineByDevice.get(p.parent)!;
      }
      return true;
    };

    const zones: HiveHeatingZone[] = [];
    const hotWater: HiveHotWater[] = [];

    for (const p of products) {
      if (p.type === 'heating') {
        zones.push(this.parseHeating(p, resolveOnline(p)));
      } else if (p.type === 'hotwater') {
        hotWater.push(this.parseHotWater(p, resolveOnline(p)));
      }
    }

    return { zones, hotWater };
  }

  private parseHeating(p: any, online: boolean): HiveHeatingZone {
    const state = p.state ?? {};
    const props = p.props ?? {};
    let mode: HiveMode = state.mode ?? 'SCHEDULE';
    // When boosting, the "real" underlying mode is stashed in props.previous.
    if (mode === 'BOOST' && props.previous?.mode) {
      mode = props.previous.mode;
    }
    return {
      id: p.id,
      type: 'heating',
      name: state.name ?? 'Heating',
      online,
      currentTemperature: Number(props.temperature ?? 0),
      targetTemperature: Number(state.target ?? state.heat ?? 20),
      mode,
      heating: props.working === true,
    };
  }

  private parseHotWater(p: any, online: boolean): HiveHotWater {
    const state = p.state ?? {};
    const props = p.props ?? {};
    const rawMode: HiveMode = state.mode ?? 'SCHEDULE';
    const boosting = rawMode === 'BOOST';
    // When boosting, the "real" underlying mode is stashed in props.previous.
    const previousMode: HiveMode =
      boosting && props.previous?.mode ? props.previous.mode : rawMode;
    const baseName = state.name ?? 'Hot Water';
    // Hive often names the hot water product the same as a heating zone (e.g.
    // "Downstairs"), which collides with that zone's thermostat in HomeKit.
    // Append "Hot Water" for clarity unless it's already in the name.
    const name = /hot\s*water/i.test(baseName)
      ? baseName
      : `${baseName} Hot Water`;
    return {
      id: p.id,
      type: 'hotwater',
      name,
      online,
      mode: previousMode,
      on: props.working === true,
      boosting,
      previousMode: boosting ? previousMode : rawMode,
    };
  }

  /**
   * Write hosts in preference order. The main beekeeper host (which also serves
   * reads) is tried first; the regional `-uk` host is a fallback for accounts
   * that need it. We fall through to the next host on a gateway-level rejection
   * (403/404) — the AWS API Gateway in front of Hive returns those when the host
   * doesn't route the request, so the alternate host is worth a try.
   */
  private getWriteBases(): string[] {
    return [...new Set([HIVE_URLS.beekeeperBase, HIVE_URLS.beekeeperWriteBase])];
  }

  /** POST a state change to a node. */
  private async setNodeState(
    type: 'heating' | 'hotwater',
    id: string,
    payload: Record<string, string | number>,
  ): Promise<void> {
    let lastError: Error | undefined;

    for (const base of this.getWriteBases()) {
      const url = `${base}/nodes/${type}/${id}`;
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
      });
      if (res.status === 401) {
        throw new TokenExpiredError();
      }
      if (res.ok) {
        this.log.debug(`Hive ${type}/${id} <= ${JSON.stringify(payload)} via ${base}`);
        return;
      }

      const text = await res.text().catch(() => '');
      const detail = text ? ` ${this.sanitiseErrorBody(text)}` : '';
      lastError = new Error(
        `Hive setState ${type}/${id} failed via ${base}: HTTP ${res.status}${detail}`,
      );
      // 403/404 are gateway-level "this host won't route that" responses; try
      // the next host. Any other status means the host handled the request and
      // genuinely rejected it, so stop and report.
      if (res.status !== 403 && res.status !== 404) {
        break;
      }
    }

    throw lastError ?? new Error(`Hive setState ${type}/${id} failed.`);
  }

  private sanitiseErrorBody(text: string): string {
    return text.replace(/\s+/g, ' ').slice(0, 300);
  }

  setHeatingTarget(id: string, temp: number): Promise<void> {
    return this.setNodeState('heating', id, { mode: 'MANUAL', target: temp });
  }

  setHeatingMode(id: string, mode: HiveMode): Promise<void> {
    return this.setNodeState('heating', id, { mode });
  }

  setHotWaterMode(id: string, mode: HiveMode): Promise<void> {
    return this.setNodeState('hotwater', id, { mode });
  }

  /** Boost hot water on for a number of minutes. */
  setHotWaterBoost(id: string, minutes: number): Promise<void> {
    return this.setNodeState('hotwater', id, { mode: 'BOOST', boost: minutes });
  }

  /**
   * Cancel a hot water boost, returning to the previous mode.
   * `previousMode` is the mode the zone was in before boosting (defaults to
   * SCHEDULE, which is the most common resting state).
   */
  cancelHotWaterBoost(id: string, previousMode: HiveMode = 'SCHEDULE'): Promise<void> {
    return this.setNodeState('hotwater', id, { mode: previousMode });
  }
}

/** Raised on a 401 so the platform knows to refresh tokens and retry. */
export class TokenExpiredError extends Error {
  constructor() {
    super('Hive access token expired (HTTP 401).');
    this.name = 'TokenExpiredError';
  }
}
