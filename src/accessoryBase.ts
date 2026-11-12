/**
 * What every HomeKit accessory here shares: the latest Hive state, and the
 * rules for when it is reported as No Response instead of served as live.
 */

import { Characteristic, PlatformAccessory, Service, WithUUID } from 'homebridge';
import type { HiveThermostatPlatform } from './platform';
import { LOW_BATTERY_PERCENT } from './settings';

export abstract class HiveAccessoryBase<State extends { online: boolean; battery?: number }> {
  protected latest?: State;
  /** Set while Hive is not answering; cleared by the next update(). */
  private unreachable = false;
  /** Present once Hive has reported a battery level; see trackBattery(). */
  private batteryService?: Service;

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

  // ---- Battery ---------------------------------------------------------------
  //
  // A Battery service is added with the first battery level Hive reports, so
  // the level it shows is always a real one: HomeKit's default of 0% would
  // raise a low-battery alert for a device that is fine. A poll that carries
  // no reading keeps the last real one, which the characteristic holds.

  /** Wire up a Battery service restored from the cache. Call from the constructor. */
  protected restoreBattery(accessory: PlatformAccessory): void {
    const cached = accessory.getService(this.platform.Service.Battery);
    if (cached) {
      this.attachBattery(cached);
    }
  }

  /** Push the latest battery level, adding the service on the first one. */
  protected trackBattery(accessory: PlatformAccessory, level: number | undefined): void {
    if (level === undefined) {
      return;
    }
    const { Service, Characteristic } = this.platform;
    if (!this.batteryService) {
      this.attachBattery(accessory.addService(Service.Battery));
    }
    this.batteryService!.updateCharacteristic(Characteristic.BatteryLevel, level);
    this.batteryService!.updateCharacteristic(Characteristic.StatusLowBattery, this.lowBattery());
  }

  /** StatusLowBattery for the latest level, for services that carry it too. */
  protected lowBattery(): number {
    const { Characteristic } = this.platform;
    return this.batteryLevel() <= LOW_BATTERY_PERCENT
      ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  private attachBattery(service: Service): void {
    const { Characteristic } = this.platform;
    this.batteryService = service;
    service
      .getCharacteristic(Characteristic.BatteryLevel)
      .onGet(() => this.guard(() => this.batteryLevel()));
    service
      .getCharacteristic(Characteristic.StatusLowBattery)
      .onGet(() => this.guard(() => this.lowBattery()));
    // Hive's battery devices take AA cells, so they can never charge. The
    // value is stored as well as served: HAP answers a repeat /accessories
    // request within 5s from the stored value, which otherwise stays at the
    // default NOT_CHARGING and makes the Home app show a charging status.
    service
      .getCharacteristic(Characteristic.ChargingState)
      .updateValue(Characteristic.ChargingState.NOT_CHARGEABLE)
      .onGet(() => Characteristic.ChargingState.NOT_CHARGEABLE);
  }

  private batteryLevel(): number {
    const { Characteristic } = this.platform;
    return (
      this.latest?.battery ??
      ((this.batteryService?.getCharacteristic(Characteristic.BatteryLevel).value as number) ?? 100)
    );
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
