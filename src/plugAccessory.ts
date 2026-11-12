/**
 * HivePlugAccessory — a Hive Active Plug as a HomeKit Outlet.
 *
 * Outlet In Use comes from Hive's `inUse` flag where it reports one, and
 * otherwise follows On.
 */

import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { HiveThermostatPlatform } from './platform';
import { HivePlug } from './hiveApi';
import { HiveAccessoryBase } from './accessoryBase';

export class HivePlugAccessory extends HiveAccessoryBase<HivePlug> {
  private readonly service: Service;

  constructor(
    platform: HiveThermostatPlatform,
    private readonly accessory: PlatformAccessory,
    hiveId: string,
  ) {
    super(platform, () => this.service, platform.Characteristic.On);
    const { Service, Characteristic } = this.platform;

    this.accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Hive')
      .setCharacteristic(Characteristic.Model, 'Active Plug')
      .setCharacteristic(Characteristic.SerialNumber, hiveId);

    this.service =
      this.accessory.getService(Service.Outlet) ||
      this.accessory.addService(Service.Outlet);

    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.guard(() => this.latest!.on))
      .onSet((v) => this.setOn(v));
    this.service
      .getCharacteristic(Characteristic.OutletInUse)
      .onGet(() => this.guard(() => this.inUse()));
  }

  update(plug: HivePlug): void {
    if (!this.accept(plug)) {
      return;
    }
    const { Characteristic } = this.platform;
    this.service.updateCharacteristic(Characteristic.On, plug.on);
    this.service.updateCharacteristic(Characteristic.OutletInUse, this.inUse());
  }

  private inUse(): boolean {
    return this.latest!.inUse ?? this.latest!.on;
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    const latest = this.requireState();
    const on = value === true || value === 1;
    await this.platform.setPlug(latest.id, on);
    latest.on = on;
    this.platform.pollSoon();
  }
}
