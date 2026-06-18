/**
 * HiveHeatingAccessory — maps a Hive heating zone to a HomeKit Thermostat.
 *
 * Mode mapping (Hive -> HomeKit TargetHeatingCoolingState):
 *   OFF                  -> OFF
 *   MANUAL               -> HEAT
 *   SCHEDULE             -> AUTO
 *   (BOOST is surfaced as HEAT; underlying mode tracked by the API layer)
 *
 * Cool is never exposed (Hive cannot cool). Auto is kept so the Hive schedule
 * stays selectable from HomeKit. Note: Apple Home honours validValues and hides
 * Cool, but the Homebridge accessories UI renders a generic thermostat control
 * that always shows all four buttons regardless of validValues.
 *
 * When offline, characteristics are reported with a NO_RESPONSE error so the
 * Home app shows "No Response" rather than stale values.
 */

import { PlatformAccessory, Service, CharacteristicValue } from 'homebridge';
import type { HiveThermostatPlatform } from './platform';
import { HiveHeatingZone, HiveMode } from './hiveApi';
import { HIVE_MIN_TEMP, HIVE_MAX_TEMP, HIVE_TEMP_STEP } from './settings';

export class HiveHeatingAccessory {
  private readonly service: Service;
  private latest?: HiveHeatingZone;

  constructor(
    private readonly platform: HiveThermostatPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly hiveId: string,
  ) {
    const { Service, Characteristic } = this.platform;

    this.accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Hive')
      .setCharacteristic(Characteristic.Model, 'Heating Zone')
      .setCharacteristic(Characteristic.SerialNumber, hiveId);

    this.service =
      this.accessory.getService(Service.Thermostat) ||
      this.accessory.addService(Service.Thermostat);

    this.service
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [
          Characteristic.TargetHeatingCoolingState.OFF,
          Characteristic.TargetHeatingCoolingState.HEAT,
          Characteristic.TargetHeatingCoolingState.AUTO,
        ],
      })
      .onGet(() => this.guard(() => this.targetState()))
      .onSet((v) => this.setTargetState(v));

    this.service
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .onGet(() => this.guard(() => this.currentState()));

    this.service
      .getCharacteristic(Characteristic.TargetTemperature)
      .setProps({
        minValue: HIVE_MIN_TEMP,
        maxValue: HIVE_MAX_TEMP,
        minStep: HIVE_TEMP_STEP,
      })
      .onGet(() => this.guard(() => this.latest!.targetTemperature))
      .onSet((v) => this.setTargetTemp(v));

    this.service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.guard(() => this.latest!.currentTemperature));

    this.service
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => Characteristic.TemperatureDisplayUnits.CELSIUS);
  }

  /** Push fresh state into HomeKit. */
  update(zone: HiveHeatingZone): void {
    this.latest = zone;
    const { Characteristic } = this.platform;

    if (!zone.online) {
      // Mark unreachable; getters will throw NO_RESPONSE.
      this.service.updateCharacteristic(
        Characteristic.CurrentTemperature,
        new Error('offline') as unknown as CharacteristicValue,
      );
      return;
    }

    this.service.updateCharacteristic(
      Characteristic.CurrentTemperature,
      zone.currentTemperature,
    );
    this.service.updateCharacteristic(
      Characteristic.TargetTemperature,
      zone.targetTemperature,
    );
    this.service.updateCharacteristic(
      Characteristic.CurrentHeatingCoolingState,
      this.currentState(),
    );
    this.service.updateCharacteristic(
      Characteristic.TargetHeatingCoolingState,
      this.targetState(),
    );
  }

  // ---- getters -------------------------------------------------------------

  private guard<T>(fn: () => T): T {
    if (!this.latest || !this.latest.online) {
      throw new this.platform.homebridgeApi.hap.HapStatusError(
        this.platform.homebridgeApi.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return fn();
  }

  private currentState(): number {
    const { Characteristic } = this.platform;
    return this.latest!.heating
      ? Characteristic.CurrentHeatingCoolingState.HEAT
      : Characteristic.CurrentHeatingCoolingState.OFF;
  }

  private targetState(): number {
    const { Characteristic } = this.platform;
    switch (this.latest!.mode) {
      case 'OFF':
        return Characteristic.TargetHeatingCoolingState.OFF;
      case 'SCHEDULE':
        return Characteristic.TargetHeatingCoolingState.AUTO;
      default:
        return Characteristic.TargetHeatingCoolingState.HEAT;
    }
  }

  // ---- setters -------------------------------------------------------------

  private async setTargetState(value: CharacteristicValue): Promise<void> {
    const { Characteristic } = this.platform;
    let mode: HiveMode;
    switch (value) {
      case Characteristic.TargetHeatingCoolingState.OFF:
        mode = 'OFF';
        break;
      case Characteristic.TargetHeatingCoolingState.AUTO:
        mode = 'SCHEDULE';
        break;
      default:
        mode = 'MANUAL';
    }
    await this.platform.hive.setHeatingMode(this.hiveId, mode);
    if (this.latest) {
      this.latest.mode = mode;
    }
    this.platform.pollSoon();
  }

  private async setTargetTemp(value: CharacteristicValue): Promise<void> {
    await this.platform.hive.setHeatingTarget(this.hiveId, value as number);
    if (this.latest) {
      this.latest.targetTemperature = value as number;
      this.latest.mode = 'MANUAL';
    }
    this.platform.pollSoon();
  }
}
