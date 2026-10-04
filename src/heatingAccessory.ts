/**
 * HiveHeatingAccessory — maps a Hive heating zone to a HomeKit Thermostat.
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
import { HiveHeatingZone, HiveMode } from './hiveApi';
import { HIVE_MIN_TEMP, HIVE_MAX_TEMP, HIVE_TEMP_STEP } from './settings';

export class HiveHeatingAccessory {
  private readonly service: Service;
  private latest?: HiveHeatingZone;
  /** Set while Hive is not answering; cleared by the next update(). */
  private unreachable = false;

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
    this.unreachable = false;
    const { Characteristic } = this.platform;

    if (!zone.online) {
      // Mark unreachable; getters will throw NO_RESPONSE.
      this.reportUnreachable();
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

  /** Hive has stopped answering; see HiveThermostatPlatform.markUnreachable(). */
  markUnreachable(): void {
    this.unreachable = true;
    this.reportUnreachable();
  }

  private reportUnreachable(): void {
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      this.communicationFailure(),
    );
  }

  // ---- getters -------------------------------------------------------------

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

  /**
   * The zone's state, for a write to act on. Until a poll has delivered one
   * there is nothing to act on — Hive may not even be signed in yet — so the
   * write is refused rather than silently accepted.
   */
  private requireState(): HiveHeatingZone {
    if (!this.latest) {
      throw this.communicationFailure();
    }
    return this.latest;
  }

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
    await this.platform.setHeatingMode(this.hiveId, mode);
    latest.mode = mode;
    this.platform.pollSoon();
  }

  private async setTargetTemp(value: CharacteristicValue): Promise<void> {
    const latest = this.requireState();
    await this.platform.setHeatingTarget(this.hiveId, value as number, latest);
    // A zone on its schedule stays there (see HiveApi.setHeatingTarget());
    // anything else is now MANUAL.
    if (latest.mode !== 'SCHEDULE' || latest.boosting) {
      latest.mode = 'MANUAL';
    }
    latest.targetTemperature = value as number;
    this.platform.pollSoon();
  }
}
