/**
 * HiveLightAccessory — a Hive Active Light as a HomeKit Lightbulb.
 *
 *   warm white light         -> On, Brightness
 *   tuneable light           -> + Color Temperature
 *   colour tuneable light    -> + Color Temperature, Hue, Saturation
 *
 * Hive takes brightness in 5% steps and never below 5% while on, so the
 * Brightness slider moves in 5% steps too. HomeKit's colour temperature is in
 * mireds and Hive's in kelvin; the slider's range is the bulb's own.
 *
 * HomeKit sets a colour as two writes, Hue then Saturation, but Hive takes
 * them together. The two are gathered for a moment and sent as one write, so
 * the bulb does not flash through a colour made of the new hue and the old
 * saturation.
 */

import { Characteristic, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';
import type { HiveThermostatPlatform } from './platform';
import { HiveLight, HiveLightType } from './hiveApi';
import { HiveAccessoryBase } from './accessoryBase';
import { LIGHT_BRIGHTNESS_STEP } from './settings';
import { hiveBrightness, kelvinToMireds } from './lightUnits';

/** How long to wait for the other half of a hue/saturation pair. */
export const COLOUR_GATHER_MS = 100;

const MODEL: Record<HiveLightType, string> = {
  warmwhitelight: 'Active Light Dimmable',
  tuneablelight: 'Active Light Tuneable',
  colourtuneablelight: 'Active Light Colour',
};

type PendingColour = { hue?: number; saturation?: number; write: Promise<void> };

export class HiveLightAccessory extends HiveAccessoryBase<HiveLight> {
  private readonly service: Service;
  private readonly tuneable: boolean;
  private readonly colour: boolean;
  private pendingColour?: PendingColour;

  constructor(
    platform: HiveThermostatPlatform,
    private readonly accessory: PlatformAccessory,
    hiveId: string,
    hiveType: HiveLightType,
  ) {
    super(platform, () => this.service, platform.Characteristic.On);
    const { Service, Characteristic } = this.platform;
    this.tuneable = hiveType !== 'warmwhitelight';
    this.colour = hiveType === 'colourtuneablelight';

    this.accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Hive')
      .setCharacteristic(Characteristic.Model, MODEL[hiveType])
      .setCharacteristic(Characteristic.SerialNumber, hiveId);

    this.service =
      this.accessory.getService(Service.Lightbulb) ||
      this.accessory.addService(Service.Lightbulb);

    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.guard(() => this.latest!.on))
      .onSet((v) => this.setOn(v));

    this.service
      .getCharacteristic(Characteristic.Brightness)
      .setProps({ minValue: 0, maxValue: 100, minStep: LIGHT_BRIGHTNESS_STEP })
      .onGet(() => this.guard(() => this.latest!.brightness))
      .onSet((v) => this.setBrightness(v));

    if (this.tuneable) {
      this.service
        .getCharacteristic(Characteristic.ColorTemperature)
        .onGet(() => this.guard(() => this.mireds()))
        .onSet((v) => this.setColourTemperature(v));
    }
    if (this.colour) {
      this.service
        .getCharacteristic(Characteristic.Hue)
        .onGet(() => this.guard(() => this.latest!.hue ?? this.current(Characteristic.Hue)))
        .onSet((v) => this.setColour('hue', v as number));
      this.service
        .getCharacteristic(Characteristic.Saturation)
        .onGet(() =>
          this.guard(() => this.latest!.saturation ?? this.current(Characteristic.Saturation)),
        )
        .onSet((v) => this.setColour('saturation', v as number));
    }
  }

  update(light: HiveLight): void {
    if (!this.accept(light)) {
      return;
    }
    const { Characteristic } = this.platform;
    this.service.updateCharacteristic(Characteristic.On, light.on);
    this.service.updateCharacteristic(Characteristic.Brightness, light.brightness);
    if (this.tuneable) {
      this.applyColourTemperatureRange(light);
      if (light.colourTemperature !== undefined) {
        this.service.updateCharacteristic(Characteristic.ColorTemperature, this.mireds());
      }
    }
    if (this.colour) {
      if (light.hue !== undefined) {
        this.service.updateCharacteristic(Characteristic.Hue, light.hue);
      }
      if (light.saturation !== undefined) {
        this.service.updateCharacteristic(Characteristic.Saturation, light.saturation);
      }
    }
  }

  /**
   * Narrow the Color Temperature slider to what the bulb supports.
   *
   * HAP checks the value already held against the new range, and the value a
   * new characteristic starts with (140 mireds) is cooler than any Hive bulb
   * goes — so it is moved into the range first, or every startup would log an
   * "illegal value" warning for each tuneable light.
   */
  private applyColourTemperatureRange(light: HiveLight): void {
    const range = light.colourTemperatureRange;
    if (!range) {
      return;
    }
    const characteristic = this.service.getCharacteristic(this.platform.Characteristic.ColorTemperature);
    const minValue = kelvinToMireds(range.max);
    const maxValue = kelvinToMireds(range.min);
    const { props } = characteristic;
    if (props.minValue === minValue && props.maxValue === maxValue) {
      return;
    }
    const held = characteristic.value as number;
    const inRange = Math.min(maxValue, Math.max(minValue, held));
    const withinOld = inRange >= (props.minValue ?? -Infinity) && inRange <= (props.maxValue ?? Infinity);
    // Moved before narrowing wherever the old range allows it, which covers
    // every range Hive has been seen to report.
    if (inRange !== held && withinOld) {
      characteristic.updateValue(inRange);
    }
    characteristic.setProps({ minValue, maxValue });
    if (inRange !== held && !withinOld) {
      characteristic.updateValue(inRange);
    }
  }

  /** The latest colour temperature in mireds, within the slider's range. */
  private mireds(): number {
    const { Characteristic } = this.platform;
    const kelvin = this.latest!.colourTemperature;
    if (kelvin === undefined) {
      return this.current(Characteristic.ColorTemperature);
    }
    const props = this.service.getCharacteristic(Characteristic.ColorTemperature).props;
    return Math.min(props.maxValue ?? Infinity, Math.max(props.minValue ?? 0, kelvinToMireds(kelvin)));
  }

  /** The value a characteristic already holds, for a reading Hive left out. */
  private current(type: WithUUID<new () => Characteristic>): number {
    return this.service.getCharacteristic(type).value as number;
  }

  // ---- setters -------------------------------------------------------------

  private async setOn(value: CharacteristicValue): Promise<void> {
    const latest = this.requireState();
    const on = value === true || value === 1;
    await this.platform.setLight(latest, { on });
    latest.on = on;
    this.platform.pollSoon();
  }

  private async setBrightness(value: CharacteristicValue): Promise<void> {
    const latest = this.requireState();
    // Dragging the slider to zero comes with an On write that turns the light
    // off; Hive has no zero brightness to send.
    if ((value as number) <= 0) {
      return;
    }
    const brightness = hiveBrightness(value as number);
    await this.platform.setLight(latest, { brightness });
    latest.brightness = brightness;
    latest.on = true;
    this.platform.pollSoon();
  }

  private async setColourTemperature(value: CharacteristicValue): Promise<void> {
    const latest = this.requireState();
    const range = latest.colourTemperatureRange;
    let kelvin = kelvinToMireds(value as number);
    if (range) {
      kelvin = Math.min(range.max, Math.max(range.min, kelvin));
    }
    await this.platform.setLight(latest, { colourTemperature: kelvin });
    latest.colourTemperature = kelvin;
    if (this.colour) {
      latest.colourMode = 'WHITE';
    }
    this.platform.pollSoon();
  }

  /**
   * Gather a hue or saturation write with its other half, and send the pair
   * once; both writes settle with that one Hive request.
   */
  private setColour(part: 'hue' | 'saturation', value: number): Promise<void> {
    this.requireState();
    if (!this.pendingColour) {
      const pending = {} as PendingColour;
      pending.write = new Promise((resolve) => setTimeout(resolve, COLOUR_GATHER_MS)).then(
        async () => {
          this.pendingColour = undefined;
          const latest = this.requireState();
          const hue = pending.hue ?? latest.hue ?? 0;
          const saturation = pending.saturation ?? latest.saturation ?? 100;
          await this.platform.setLight(latest, { hue, saturation });
          Object.assign(latest, { hue, saturation, colourMode: 'COLOUR' });
          this.platform.pollSoon();
        },
      );
      this.pendingColour = pending;
    }
    this.pendingColour[part] = value;
    return this.pendingColour.write;
  }
}
