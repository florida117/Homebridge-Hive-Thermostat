# Changelog

All notable changes to this project are documented here.

## [1.0.7] - 2026-09-24

**Maintenance release — no functional changes.** Nothing in the plugin itself
changed since 1.0.6; your Hive devices behave identically. This release exists
to exercise the rebuilt release pipeline, and you can safely skip it.

### Changed
- Releases are now published using npm trusted publishing (OpenID Connect)
  rather than a long-lived access token. 1.0.6 could not be published
  automatically because that token had reached npm's 90-day expiry, and npm
  reports an expired credential as a 404 on the package, which reads as though
  the package had been unpublished. There is no longer a credential to expire.
- The release workflow now checks that npm will accept its identity *before*
  publishing, so a misconfiguration fails while the release can still be
  retried rather than after the version is public.
- The GitHub Release step is now recoverable. Previously a transient API error
  after a successful publish left a version on npm with no release notes, and
  re-running could not fix it because npm refuses to republish a version — the
  Homebridge UI reads its "what's new" text from those notes.

## [1.0.6] - 2026-09-24

**A round of Matter correctness fixes.** If you use the Hive zones over Matter,
this release stops the plugin from fighting itself: scheduled temperature
changes no longer knock a zone off its Hive schedule, and a Matter controller
touching the (inert) cooling controls no longer turns your heating down. Normal
HomeKit accessories were never affected, and no configuration changes are
needed.

### Fixed
- **A scheduled Hive temperature change could switch the zone off its
  schedule.** Homebridge reports every thermostat attribute change to the
  plugin that wrote it, with nothing marking it as the plugin's own — so each
  poll that pushed a new target came straight back as though a controller had
  asked for it, and the plugin sent it to Hive as a manual setpoint. Because a
  manual setpoint also sets the mode, a zone following the Hive schedule could
  be moved to MANUAL by the schedule's own temperature change. Mode changes
  echoed the same way. The plugin now recognises its own writes.
- **A cooling setpoint written by a Matter controller silently changed your
  heating target.** Cooling is declared on this heating-only thermostat because
  the Matter spec requires it for Auto mode (which carries the Hive schedule),
  and it is pinned to the top of the range. Nothing kept it there: matter.js
  reconciles the heating and cooling setpoints as a pair, so a controller
  dragging the cooling handle to 18 °C pulled the *heating* setpoint down to
  18 °C with it — and that drag was reported as an ordinary heating change, so
  it reached Hive as a real setpoint command and turned the heating down for
  real. The drag is now recognised for what it is, and both setpoints are
  restored from Hive as soon as it happens.
- **Writing a cooling setpoint, or using the SetpointRaiseLower command, failed
  outright.** Homebridge routes both to a plugin handler and rejects the
  operation with a generic failure when none is registered, logging an error on
  every attempt. Both handlers now exist; SetpointRaiseLower adjusts the heating
  target by the requested amount, clamped to the Hive range.
- **A zone switched to manual mode while the boiler was idle reported "heating"
  until Homebridge restarted.** matter.js forces the running mode to match a
  changed system mode, which overwrote the real value; because the plugin
  recorded what it had intended to write, no later poll corrected it.
- **A Matter problem could take the plain HomeKit accessories down with it.**
  Matter registration ran unguarded on the startup path, so an exception there
  left the Hive poll timer unarmed and froze the non-Matter thermostat and hot
  water accessories too.
- **A thermostat that failed to come online stayed dead for the life of the
  process.** Registration verification is wired back to a one-shot retry, so a
  future Homebridge that composes the thermostat differently recovers instead of
  logging once and giving up. Nothing is persisted — the decision is re-derived
  on every start.
- **Startup no longer stalls for six seconds, or reports healthy thermostats as
  broken, on Homebridge builds that cannot read Matter state back.**
- The advertised cooling range is now the Matter spec's own 16–32 °C instead of
  Hive's 5–32 °C heating range. Cooling is inert either way, but a 5 °C cooling
  floor on a boiler is a fiction some controllers validate against.
- The `.hive-thermostat-matter.json` file written by 1.0.4 is removed on
  startup. 1.0.5 stopped reading it and left it behind.

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
