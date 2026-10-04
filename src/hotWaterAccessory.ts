/**
 * HiveHotWaterAccessory — exposes Hive hot water as a simple HomeKit Switch
 * with a timed boost, mirroring the behaviour of homebridge-nest's hot water
 * control.
 *
 *   Switch ON  -> boost hot water on for `hotWaterDurationMinutes` (default 30)
 *   Switch OFF -> cancel the boost, returning to the previous schedule/mode
 *
 * The switch reflects whether a boost is currently active. Scheduled on/off
 * cycles do NOT flip the switch — it specifically represents a manual boost,
 * which is what "turn the hot water on now" means to a user.
 */

import { PlatformAccessory, Service, CharacteristicValue } from 'homebridge';
import type { HiveThermostatPlatform } from './platform';
import { HiveHotWater } from './hiveApi';

export class HiveHotWaterAccessory {
  private readonly service: Service;
  private latest?: HiveHotWater;
  /** Set while Hive is not answering; cleared by the next update(). */
  private unreachable = false;

  constructor(
    private readonly platform: HiveThermostatPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly hiveId: string,
    private readonly boostMinutes: number,
  ) {
    const { Service, Characteristic } = this.platform;

    this.accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Hive')
      .setCharacteristic(Characteristic.Model, 'Hot Water')
      .setCharacteristic(Characteristic.SerialNumber, hiveId);

    this.service =
      this.accessory.getService(Service.Switch) ||
      this.accessory.addService(Service.Switch);

    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.guard(() => this.latest!.boosting))
      .onSet((v) => this.setOn(v));
  }

  update(hw: HiveHotWater): void {
    this.latest = hw;
    this.unreachable = false;
    if (!hw.online) {
      this.reportUnreachable();
      return;
    }
    this.service.updateCharacteristic(this.platform.Characteristic.On, hw.boosting);
  }

  /** Hive has stopped answering; see HiveThermostatPlatform.markUnreachable(). */
  markUnreachable(): void {
    this.unreachable = true;
    this.reportUnreachable();
  }

  private reportUnreachable(): void {
    this.service.updateCharacteristic(
      this.platform.Characteristic.On,
      this.communicationFailure(),
    );
  }

  private guard<T>(fn: () => T): T {
    if (!this.latest || !this.latest.online || this.unreachable) {
      throw this.communicationFailure();
    }
    return fn();
  }

  private communicationFailure() {
    const { HapStatusError, HAPStatus } = this.platform.homebridgeApi.hap;
    return new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    // Refuse rather than accept a write before any poll has landed — Hive may
    // not even be signed in yet.
    const latest = this.latest;
    if (!latest) {
      throw this.communicationFailure();
    }
    if (value) {
      await this.platform.setHotWaterBoost(this.hiveId, this.boostMinutes);
      latest.boosting = true;
      this.platform.log.info(
        `Hot water boosted on for ${this.boostMinutes} minutes.`,
      );
    } else {
      await this.platform.cancelHotWaterBoost(this.hiveId, latest.mode);
      latest.boosting = false;
      this.platform.log.info('Hot water boost cancelled.');
    }
    this.platform.pollSoon();
  }
}
