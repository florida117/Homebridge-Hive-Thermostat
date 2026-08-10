# Changelog

All notable changes to this project are documented here.

## [1.0.4] - 2026-08-10
### Fixed
- Hot water commands sent over Matter acted on state captured when the
  accessory was registered, rather than current state. Toggling hot water from
  a Matter controller could send the opposite of the intended command, and
  cancelling a boost could restore a mode the zone had long since left.
- Login could hang Homebridge startup indefinitely, with no error logged, if
  the Hive account returned a Cognito challenge other than SMS 2FA (for example
  a required password change). These now fail with an actionable message.
- A non-numeric `pollInterval` in the config resulted in continuous polling of
  the Hive API instead of the configured interval. `pollInterval` and
  `hotWaterDurationMinutes` are now validated.
- Slow Hive responses could cause overlapping poll cycles that each refreshed
  the access token independently. Poll cycles no longer overlap.
- An expired token during a poll discarded that cycle, leaving HomeKit with
  stale state until the next one. The poll is now retried after the refresh.
- Newly registered accessories were missing from the platform's internal
  accessory list, and removed ones were left in it.

### Changed
- Matter accessory state is only written when it has actually changed, instead
  of on every poll. This removes a Matter transaction per accessory every poll
  interval for state that is usually unchanged.
- `engines.node` now includes Node 26.

### Internal
- `npm run lint` now works: ESLint was referenced by the script but was never a
  dependency and had no configuration.
- Added a CI workflow running lint and build across Node 22, 24 and 26.

## [1.0.3] - 2026-06-18
### Fixed
- Pin `form-data` to `^4.0.6` via overrides to resolve a high-severity CRLF
  injection vulnerability in a transitive dev dependency (`@types/node-fetch`).

## [1.0.2] - 2026-06-18
### Changed
- npm publishing is now automated via GitHub Actions on version tag push.

## [1.0.1] - 2026-06-18
### Fixed
- `config.schema.json`: moved `required` from individual property fields to a
  top-level array on the schema object, fixing JSON Schema validation failure
  flagged by the Homebridge Verified check.

## [1.0.0] - 2026-06-18
First public release on npm. (Versions below are pre-release development
history.)

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
- Hive writes (mode/target/boost) target the main Beekeeper host that also
  serves reads, with the regional `-uk` host kept as a fallback. Fixes mode
  changes failing with HTTP 403 Forbidden, and the host fallback now triggers on
  403 as well as 404.

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
