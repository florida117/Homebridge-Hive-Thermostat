# Changelog

All notable changes to this project are documented here.

## [0.3.0]
### Added
- Homebridge v2 Matter support. Heating zones are exposed as Matter Thermostats
  and hot water boost controls as Matter On/Off Outlets when Matter is enabled
  for the bridge.
- `enableMatter` config option to allow users to opt out of Matter accessory
  registration while keeping Homebridge Matter enabled for the bridge.
- Selecting Auto on a heating zone now switches it to the Hive schedule, on both
  the HomeKit (HAP) thermostat and the Matter thermostat. On Matter the Cool
  button is still shown (the bridge thermostat type advertises Cooling) but is
  inert — the heating-only control sequence makes Matter reject a Cool selection.

### Fixed
- Matter thermostat registration supplies the occupancy metadata required by
  Homebridge's Matter thermostat validation.
- Matter thermostats self-heal the Presets feature: the required state differs
  between Homebridge/matter.js builds, so registration verifies each thermostat
  came online and retries with the opposite Presets setting if needed, then
  remembers the working choice across restarts.
- Matter serial numbers are normalised to fit Matter length constraints when
  Hive product IDs are UUID-shaped.
- Hive writes now use the current UK Beekeeper host, with the legacy host kept
  as a fallback for 404 responses.

### Changed
- Development dependency and engine metadata now target Homebridge v2 and
  supported Node.js versions for Matter.

## [0.2.1]
### Fixed
- Hot water accessories are now named "<zone> Hot Water" to avoid colliding
  with a heating zone of the same name (Hive often names both identically).
- Accessory display names now update if the Hive name changes, rather than
  being fixed at first creation.

## [0.2.0]
### Added
- Poll-after-write: changes made from HomeKit are confirmed by a one-off
  refresh a few seconds after each command, rather than waiting for the next
  scheduled poll.
- Hot water boost duration is now a dropdown of presets in the config UI.

### Changed
- Default poll interval lowered from 30s to 15s for snappier updates.
- Poll interval now renders as a number input instead of a slider.

## [0.1.0]
### Added
- Initial release.
- Cognito SRP authentication with one-time SMS 2FA and refresh-token reuse.
- Auto-discovery of Hive heating zones and hot water.
- Heating zones exposed as HomeKit Thermostats (off / heat / schedule).
- Hot water exposed as a Switch with a timed boost.
- Reports "No Response" in the Home app when Hive marks a device offline.
