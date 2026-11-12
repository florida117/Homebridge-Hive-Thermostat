/**
 * HiveHeatingAccessory — maps a Hive heating zone, or a room of Hive radiator
 * valves, to a HomeKit Thermostat. The two behave identically in Hive; a
 * radiator valve also carries a Battery service, since the valves run on AA
 * cells (see HiveAccessoryBase.trackBattery()).
 *
 * Mode mapping (Hive -> HomeKit TargetHeatingCoolingState):
 *   OFF                  -> OFF
 *   MANUAL               -> HEAT
 *   SCHEDULE             -> AUTO
 *   During a boost the zone shows the mode it will return to (the API layer
 *   reads it from Hive), or HEAT when Hive does not say.
 *
 * Cool is never exposed (Hive cannot cool). Auto is kept so the Hive schedule
 * stays selectable from HomeKit. Note: Apple Home honours validValues and hides
 * Cool, but the Homebridge accessories UI renders a generic thermostat control
 * that always shows all four buttons regardless of validValues.
 *
 * Until the first poll lands, when Hive marks the zone offline, or when Hive
 * itself has stopped answering, reads fail with a communication error so the
 * Home app shows "No Response" rather than stale values.
 */

import { PlatformAccessory, Service, CharacteristicValue } from 'homebridge';
import type { HiveThermostatPlatform } from './platform';
import { HiveHeatingType, HiveHeatingZone, HiveMode } from './hiveApi';
import { HIVE_MIN_TEMP, HIVE_MAX_TEMP, HIVE_TEMP_STEP } from './settings';
import { HiveAccessoryBase } from './accessoryBase';

export class HiveHeatingAccessory extends HiveAccessoryBase<HiveHeatingZone> {
  private readonly service: Service;

  constructor(
    platform: HiveThermostatPlatform,
    private readonly accessory: PlatformAccessory,
    hiveId: string,
    hiveType: HiveHeatingType,
  ) {
    super(platform, () => this.service, platform.Characteristic.CurrentTemperature);
    const { Service, Characteristic } = this.platform;
    const valve = hiveType === 'trvcontrol';

    this.accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Hive')
      .setCharacteristic(Characteristic.Model, valve ? 'Radiator Valve' : 'Heating Zone')
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

    this.restoreBattery(this.accessory);
  }

  /** Push fresh state into HomeKit. */
  update(zone: HiveHeatingZone): void {
    if (!this.accept(zone)) {
      return;
    }
    const { Characteristic } = this.platform;

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
    this.trackBattery(this.accessory, zone.battery);
  }

  // ---- getters -------------------------------------------------------------

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
    const latest = this.requireState();
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
    await this.platform.setHeatingMode(latest, mode);
    latest.mode = mode;
    this.platform.pollSoon();
  }

  private async setTargetTemp(value: CharacteristicValue): Promise<void> {
    const latest = this.requireState();
    await this.platform.setHeatingTarget(latest, value as number);
    // A zone on its schedule stays there (see HiveApi.setHeatingTarget());
    // anything else is now MANUAL.
    if (latest.mode !== 'SCHEDULE' || latest.boosting) {
      latest.mode = 'MANUAL';
    }
    latest.targetTemperature = value as number;
    this.platform.pollSoon();
  }
}
