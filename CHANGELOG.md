# Changelog

All notable changes to this project are documented here.

## [1.0.5] - 2026-08-16

**If your Hive heating zones stopped appearing over Matter after updating to
Homebridge 2.3.0 or later, this release fixes it.** Homebridge 2.3.0 changed how
a plugin's Matter thermostat is built, which caused this plugin's thermostat
endpoints to fail validation and never come online. Hot water was unaffected,
and normal HomeKit (non-Matter) accessories were never affected. No
configuration changes are needed. Homebridge 2.4.0 or later is recommended.

### Fixed
- **Matter thermostats failed to register on Homebridge 2.3.0 and later.**
  Homebridge 2.3.0 changed `deviceTypes.Thermostat` from a type pre-composed
  with Heating/Cooling/AutoMode/Occupancy to a bare device type whose features
  are detected from the setpoints an accessory declares. Declaring only a
  heating setpoint left the endpoint with Heating alone, and the hardcoded
  `occupancy` attribute was then rejected with `Conformance "OCC": Matter does
  not allow you to set this attribute`, taking the whole thermostat endpoint
  down. The `occupancy` attribute has been removed — Hive has no occupancy
  sensing and it was always a hardcoded `true`.
- **Every thermostat setpoint update would have been rejected** once AutoMode
  was live, with "Thermostat setpoints could not be reconciled within the
  configured limits". matter.js 0.17.7 (shipped in Homebridge 2.3.0) began
  validating the whole thermostat cluster rather than only the attribute being
  written, and the undeclared cooling limits fell back to the spec's 16–32°C,
  which cannot satisfy the default 2°C deadband against a 5–32°C heating range.
  The cooling limits and a zero deadband are now declared explicitly.

### Changed
- Matter thermostat features are now composed explicitly via
  `api.matter.deviceRequirements` on Homebridge 2.4.0+, so Heating, Cooling and
  AutoMode are pinned rather than inferred. On 2.3.x, where a plugin cannot
  override detection, the declared cooling setpoint makes Homebridge derive the
  same feature set. The Hive schedule therefore stays available as Matter Auto
  on every supported Homebridge version. Cooling remains inert: the control
  sequence is HeatingOnly and the cooling setpoint is pinned to the top of the
  range.
- Matter commands that arrive before Hive authentication completes now return
  an `InvalidInState` Matter status via `api.matter.status` (Homebridge 2.3.0+)
  rather than a generic failure, so a controller can retry instead of showing
  the command as failed.

### Removed
- The Matter Presets guess-retry-and-remember machinery. The feature set is now
  derived from observable properties of the running Homebridge rather than
  guessed, so the failed first registration attempt, the re-registration retry
  and the persisted `.hive-thermostat-matter.json` decision file are all gone.
  Presets is declared only on Homebridge ≤ 2.2.x, where a bug in Homebridge's
  cluster-feature detection left matter.js's default feature set (which
  includes Presets) live on the endpoint and made `presetTypes` mandatory.
  An existing `.hive-thermostat-matter.json` in the Homebridge storage
  directory is now unused and can be deleted.

### Internal
- Development dependency on `homebridge` bumped to `^2.4.0`. The supported
  range in `engines` is unchanged at `>=2.0.0`.

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
