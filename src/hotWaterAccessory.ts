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
import { HiveAccessoryBase } from './accessoryBase';

export class HiveHotWaterAccessory extends HiveAccessoryBase<HiveHotWater> {
  private readonly service: Service;

  constructor(
    platform: HiveThermostatPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly hiveId: string,
    private readonly boostMinutes: number,
  ) {
    super(platform, () => this.service, platform.Characteristic.On);
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
    if (this.accept(hw)) {
      this.service.updateCharacteristic(this.platform.Characteristic.On, hw.boosting);
    }
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    const latest = this.requireState();
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
