/**
 * HiveSensorAccessory — a Hive motion sensor as a HomeKit Motion Sensor, or a
 * Hive window/door sensor as a HomeKit Contact Sensor, each with a Battery
 * service once Hive reports a level.
 *
 * Hive is polled from the cloud, so a change reaches HomeKit at the next poll
 * (15 seconds by default) rather than the moment it happens.
 */

import { PlatformAccessory, Service } from 'homebridge';
import type { HiveThermostatPlatform } from './platform';
import { HiveSensor, HiveSensorType } from './hiveApi';
import { HiveAccessoryBase } from './accessoryBase';

export class HiveSensorAccessory extends HiveAccessoryBase<HiveSensor> {
  private readonly service: Service;
  private readonly motion: boolean;

  constructor(
    platform: HiveThermostatPlatform,
    private readonly accessory: PlatformAccessory,
    hiveId: string,
    hiveType: HiveSensorType,
  ) {
    const motion = hiveType === 'motionsensor';
    super(
      platform,
      () => this.service,
      motion ? platform.Characteristic.MotionDetected : platform.Characteristic.ContactSensorState,
    );
    this.motion = motion;
    const { Service, Characteristic } = this.platform;

    this.accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Hive')
      .setCharacteristic(Characteristic.Model, motion ? 'Motion Sensor' : 'Window/Door Sensor')
      .setCharacteristic(Characteristic.SerialNumber, hiveId);

    const type = motion ? Service.MotionSensor : Service.ContactSensor;
    this.service = this.accessory.getService(type) || this.accessory.addService(type);
    this.service
      .getCharacteristic(this.stateCharacteristic())
      .onGet(() => this.guard(() => this.state()));

    this.restoreBattery(this.accessory);
  }

  update(sensor: HiveSensor): void {
    if (!this.accept(sensor)) {
      return;
    }
    this.service.updateCharacteristic(this.stateCharacteristic(), this.state());
    this.trackBattery(this.accessory, sensor.battery);
  }

  private stateCharacteristic() {
    const { Characteristic } = this.platform;
    return this.motion ? Characteristic.MotionDetected : Characteristic.ContactSensorState;
  }

  private state(): boolean | number {
    if (this.motion) {
      return this.latest!.triggered;
    }
    const { ContactSensorState } = this.platform.Characteristic;
    return this.latest!.triggered
      ? ContactSensorState.CONTACT_NOT_DETECTED
      : ContactSensorState.CONTACT_DETECTED;
  }
}
