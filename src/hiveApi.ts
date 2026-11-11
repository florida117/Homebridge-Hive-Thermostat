/**
 * HiveApi — thin client over Hive's beekeeper API.
 *
 * Responsibilities:
 *   - GET /nodes/all  → parse heating zones, radiator valves and hot water into
 *     a normalised shape
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

/**
 * The Hive products that are driven as a heating zone: a boiler zone
 * (`heating`), or a room of radiator valves (`trvcontrol`). Both take the same
 * mode and target writes; the type is the node path they are written to.
 */
export type HiveHeatingType = 'heating' | 'trvcontrol';

export interface HiveHeatingZone {
  id: string;
  type: HiveHeatingType;
  name: string;
  online: boolean;
  currentTemperature: number;
  targetTemperature: number;
  /** While boosting, the mode the zone returns to when the boost ends. */
  mode: HiveMode;
  /** Whether a boost is currently active. */
  boosting: boolean;
  /**
   * Whether the zone is calling for heat right now — the boiler for a heating
   * zone, the valve for a radiator valve.
   */
  heating: boolean;
  /**
   * Radiator valves only: the lowest battery level, in percent, among the
   * room's valves that report one. Absent for heating zones, and for a room
   * whose valves report none.
   */
  battery?: number;
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
    // lookup of deviceId -> device, so a product can resolve it via `parent`.
    const deviceById = new Map<string, any>();
    for (const d of devices) {
      deviceById.set(d.id, d);
    }

    const resolveOnline = (p: any): boolean => {
      // A product's `parent` is the device id. Fall back to true if unknown
      // rather than wrongly flagging No Response.
      if (p.parent && deviceById.has(p.parent)) {
        return deviceById.get(p.parent).props?.online !== false;
      }
      return true;
    };

    const zones: HiveHeatingZone[] = [];
    const hotWater: HiveHotWater[] = [];

    for (const p of products) {
      if (p.type === 'heating') {
        zones.push(this.parseHeating(p, resolveOnline(p)));
      } else if (p.type === 'trvcontrol') {
        zones.push(this.parseRadiatorValve(p, deviceById));
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

  /**
   * A radiator valve room. Hive models it as a `trvcontrol` product — the
   * room's schedule, mode and target, shaped exactly like a heating zone —
   * driving one or more `trv` devices, listed in `props.trvs`.
   *
   * The product's `parent` is the hub, not a valve, so the heating zone's
   * parent lookup would report the hub's status. Online status comes from the
   * valves instead: the room is controllable while any of its valves is, and
   * offline when Hive marks the product itself offline. Battery is the lowest
   * any valve reports, since that is the one that needs changing first.
   */
  private parseRadiatorValve(p: any, deviceById: Map<string, any>): HiveHeatingZone {
    const props = p.props ?? {};
    const valveIds: unknown[] = Array.isArray(props.trvs) ? props.trvs : [];
    const valves = valveIds
      .map((id) => deviceById.get(id as string))
      .filter((d) => d !== undefined);

    const online =
      props.online !== false &&
      (valves.length === 0 || valves.some((d) => d.props?.online !== false));

    // Only real readings: a null coerced to 0 would raise a false low-battery
    // alert.
    const levels: number[] = valves
      .map((d) => d.props?.battery)
      .filter((level): level is number =>
        typeof level === 'number' && Number.isFinite(level) && level >= 0 && level <= 100);

    return {
      ...this.parseHeating(p, online),
      type: 'trvcontrol',
      name: p.state?.name ?? props.zoneName ?? 'Radiator Valve',
      ...(levels.length ? { battery: Math.min(...levels) } : {}),
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
    type: HiveHeatingType | 'hotwater',
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
   *
   * The zone's type picks the node written to, so the same call serves heating
   * zones and radiator valves.
   */
  setHeatingTarget(zone: HiveHeatingZone, temp: number): Promise<void> {
    const onSchedule = zone.mode === 'SCHEDULE' && !zone.boosting;
    return this.setNodeState(
      zone.type,
      zone.id,
      onSchedule ? { target: temp } : { mode: 'MANUAL', target: temp },
    );
  }

  setHeatingMode(zone: HiveHeatingZone, mode: HiveMode): Promise<void> {
    return this.setNodeState(zone.type, zone.id, { mode });
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
