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
    const { Characteristic } = this.platform;
    if (!hw.online) {
      this.service.updateCharacteristic(
        Characteristic.On,
        new Error('offline') as unknown as CharacteristicValue,
      );
      return;
    }
    this.service.updateCharacteristic(Characteristic.On, hw.boosting);
  }

  private guard<T>(fn: () => T): T {
    if (!this.latest || !this.latest.online) {
      throw new this.platform.homebridgeApi.hap.HapStatusError(
        this.platform.homebridgeApi.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return fn();
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    if (value) {
      await this.platform.hive.setHotWaterBoost(this.hiveId, this.boostMinutes);
      if (this.latest) {
        this.latest.boosting = true;
      }
      this.platform.log.info(
        `Hot water boosted on for ${this.boostMinutes} minutes.`,
      );
    } else {
      const prev = this.latest?.previousMode ?? 'SCHEDULE';
      await this.platform.hive.cancelHotWaterBoost(this.hiveId, prev);
      if (this.latest) {
        this.latest.boosting = false;
      }
      this.platform.log.info('Hot water boost cancelled.');
    }
    this.platform.pollSoon();
  }
}
