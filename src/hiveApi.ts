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
import { HIVE_URLS, HIVE_USER_AGENT } from './settings';
import { fetchWithTimeout } from './timeout';

export type HiveMode = 'SCHEDULE' | 'MANUAL' | 'OFF' | 'BOOST';

/**
 * Write hosts in preference order. The main beekeeper host (which also serves
 * reads) is tried first; the regional `-uk` host is a fallback for accounts
 * that need it. We fall through to the next host on a gateway-level rejection
 * (403/404) — the AWS API Gateway in front of Hive returns those when the host
 * doesn't route the request, so the alternate host is worth a try.
 */
const WRITE_BASES: readonly string[] = [
  ...new Set([HIVE_URLS.beekeeperBase, HIVE_URLS.beekeeperWriteBase]),
];

export interface HiveHeatingZone {
  id: string;
  type: 'heating';
  name: string;
  online: boolean;
  currentTemperature: number;
  targetTemperature: number;
  /** While boosting, the mode the zone returns to when the boost ends. */
  mode: HiveMode;
  /** Whether a boost is currently active. */
  boosting: boolean;
  /** Whether the boiler is actively calling for heat right now. */
  heating: boolean;
}

export interface HiveHotWater {
  id: string;
  type: 'hotwater';
  name: string;
  online: boolean;
  /**
   * The zone's resting mode. While boosting, this is the mode a cancelled boost
   * returns to — never BOOST itself.
   */
  mode: HiveMode;
  /** Whether hot water is currently on. */
  on: boolean;
  /** Whether a manual boost is currently active. */
  boosting: boolean;
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
      'User-Agent': HIVE_USER_AGENT,
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
    const boosting = mode === 'BOOST';
    // When boosting, the "real" underlying mode is stashed in props.previous.
    if (boosting && props.previous?.mode) {
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
      boosting,
      heating: props.working === true,
    };
  }

  private parseHotWater(p: any, online: boolean): HiveHotWater {
    const state = p.state ?? {};
    const props = p.props ?? {};
    const rawMode: HiveMode = state.mode ?? 'SCHEDULE';
    const boosting = rawMode === 'BOOST';
    // When boosting, the "real" underlying mode is stashed in props.previous.
    // Without it, SCHEDULE is the safe place to return to: sending BOOST back
    // as the mode to cancel to would ask Hive for a boost with no duration.
    const mode: HiveMode = boosting ? props.previous?.mode ?? 'SCHEDULE' : rawMode;
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
      mode,
      on: props.working === true,
      boosting,
    };
  }

  /** POST a state change to a node. */
  private async setNodeState(
    type: 'heating' | 'hotwater',
    id: string,
    payload: Record<string, string | number>,
  ): Promise<void> {
    let lastError: Error | undefined;

    for (const base of WRITE_BASES) {
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

  /**
   * Set a zone's target temperature. `current` is the zone's latest known
   * state, which decides what the change means.
   *
   * On the schedule, only the target is sent — what pyhiveapi (Home
   * Assistant's Hive library) sends in every mode — so the zone stays on its
   * schedule and Hive treats the new target as an override until the next
   * scheduled change. Anywhere else a new target means "heat to this now",
   * which is MANUAL. A boosting zone keeps that MANUAL behaviour too: what a
   * bare target does to a running boost has not been established.
   */
  setHeatingTarget(id: string, temp: number, current?: HiveHeatingZone): Promise<void> {
    const onSchedule = current?.mode === 'SCHEDULE' && !current.boosting;
    return this.setNodeState(
      'heating',
      id,
      onSchedule ? { target: temp } : { mode: 'MANUAL', target: temp },
    );
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
   * Cancel a hot water boost, returning to `returnTo` — the zone's resting
   * mode (see {@link HiveHotWater.mode}). Defaults to SCHEDULE, the most
   * common resting state.
   */
  cancelHotWaterBoost(id: string, returnTo: HiveMode = 'SCHEDULE'): Promise<void> {
    return this.setNodeState('hotwater', id, { mode: returnTo });
  }
}

/** Raised on a 401 so the platform knows to refresh tokens and retry. */
export class TokenExpiredError extends Error {
  constructor() {
    super('Hive access token expired (HTTP 401).');
    this.name = 'TokenExpiredError';
  }
}
