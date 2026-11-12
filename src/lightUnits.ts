/**
 * Unit conversions shared by the HomeKit and Matter lights.
 */

import { LIGHT_BRIGHTNESS_STEP } from './settings';

/** Kelvin <-> mireds; the conversion is its own inverse. */
export function kelvinToMireds(value: number): number {
  return Math.round(1_000_000 / value);
}

/** A brightness percentage as Hive takes it: a 5% step, at least 5%. */
export function hiveBrightness(percent: number): number {
  const stepped = Math.round(percent / LIGHT_BRIGHTNESS_STEP) * LIGHT_BRIGHTNESS_STEP;
  return Math.min(100, Math.max(LIGHT_BRIGHTNESS_STEP, stepped));
}
