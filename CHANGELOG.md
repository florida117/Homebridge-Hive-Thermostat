# Changelog

All notable changes to this project are documented here.

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
