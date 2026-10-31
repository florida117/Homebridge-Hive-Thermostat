/**
 * What every HomeKit accessory here shares: the latest Hive state, and the
 * rules for when it is reported as No Response instead of served as live.
 */

import { Characteristic, Service, WithUUID } from 'homebridge';
import type { HiveThermostatPlatform } from './platform';

export abstract class HiveAccessoryBase<State extends { online: boolean }> {
  protected latest?: State;
  /** Set while Hive is not answering; cleared by the next update(). */
  private unreachable = false;

  protected constructor(
    protected readonly platform: HiveThermostatPlatform,
    /** The service that carries the No Response report. */
    private readonly reportService: () => Service,
    /** The characteristic on it that carries the report. */
    private readonly reportCharacteristic: WithUUID<new () => Characteristic>,
  ) {}

  /**
   * Record fresh state. Returns whether it can be shown: false when Hive marks
   * the device offline, which is reported instead.
   */
  protected accept(state: State): boolean {
    this.latest = state;
    this.unreachable = false;
    if (!state.online) {
      this.reportUnreachable();
      return false;
    }
    return true;
  }

  /**
   * Report the accessory as unreachable until the next update(): Hive has
   * stopped answering, or no longer reports this device.
   */
  markUnreachable(): void {
    this.unreachable = true;
    this.reportUnreachable();
  }

  /** A read: fails with No Response unless the state is live. */
  protected guard<T>(fn: () => T): T {
    if (!this.latest || !this.latest.online || this.unreachable) {
      throw this.communicationFailure();
    }
    return fn();
  }

  /**
   * The state for a write to act on. Until a poll has delivered one there is
   * nothing to act on — Hive may not even be signed in yet — so the write is
   * refused rather than silently accepted.
   */
  protected requireState(): State {
    if (!this.latest) {
      throw this.communicationFailure();
    }
    return this.latest;
  }

  private reportUnreachable(): void {
    this.reportService().updateCharacteristic(
      this.reportCharacteristic,
      this.communicationFailure(),
    );
  }

  private communicationFailure() {
    const { HapStatusError, HAPStatus } = this.platform.homebridgeApi.hap;
    return new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }
}
