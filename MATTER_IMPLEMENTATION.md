# Matter Implementation Notes

This document explains how the Homebridge Hive Thermostat plugin is structured,
how its Matter support works, the bug that prevented Matter from working, and
the exact steps taken to diagnose and fix it.

Last updated: 2026-06-17 (branch `codex/matter-support`).

## 1. Code structure

The plugin is a **dynamic Homebridge platform**. It authenticates against the
Hive cloud, polls device state on an interval, and mirrors each device into
both HomeKit (HAP) and — when the bridge has Matter enabled — Matter.

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Entry point; registers the platform with Homebridge. |
| `src/settings.ts` | Constants: plugin/platform names, Hive URLs, poll interval, temperature bounds. |
| `src/platform.ts` | `HiveThermostatPlatform` — auth bootstrap, token persistence, device discovery, the poll loop, and HAP accessory registration. Owns the `HiveMatterPlatform` instance. |
| `src/hiveAuth.ts` | Cognito SRP login with SMS 2FA, refresh-token handling. |
| `src/hiveApi.ts` | Thin client over Hive's beekeeper API: `GET /nodes/all` to read state, `POST /nodes/{type}/{id}` to write mode / target / boost. |
| `src/heatingAccessory.ts` | HAP Thermostat service for a heating zone. |
| `src/hotWaterAccessory.ts` | HAP service for hot water boost. |
| `src/matterPlatform.ts` | **`HiveMatterPlatform`** — all Matter registration and state sync. |
| `src/fetchWithTimeout.ts` | `node-fetch` wrapper with an abort timeout. |

### Data flow

1. `platform.ts` boots: restores a stored refresh token (or logs in, possibly
   prompting for an SMS code via the `smsCode` config field), then constructs
   `HiveApi`.
2. `discoverDevices()` calls `GET /nodes/all`, normalises the response into
   `zones` and `hotWater`, registers HAP accessories, and calls
   `matterPlatform.register(state)`.
3. A `setInterval` poll (default 15 s) re-fetches state and calls
   `applyState()`, which pushes updates to both the HAP handlers and
   `matterPlatform.updateHeating()` / `updateHotWater()`.
4. Control commands (from HomeKit **or** Matter) call into `HiveApi`, then
   `pollSoon()` schedules a quick refresh so the confirmed device state is
   reflected without waiting for the next regular poll.

## 2. How the Matter layer works

Homebridge 2.1 exposes a first-class Matter Plugin API on the `api` object
(confirmed present in `homebridge@2.1.0` under `dist/matter/`):

- `api.isMatterEnabled()` — true when the (child) bridge has Matter configured.
- `api.matter` — the `MatterAPI`: `uuid`, `deviceTypes`, `clusters`,
  `clusterNames`, `types`, and `registerPlatformAccessories` /
  `updatePlatformAccessories` / `unregisterPlatformAccessories` /
  `updateAccessoryState`.

`HiveMatterPlatform` is a thin adapter:

- **Gating**: `enabled` is `api.isMatterEnabled() && !!api.matter`, so the whole
  layer no-ops cleanly on bridges without Matter. The platform only constructs
  it when the `enableMatter` config option is not `false`.
- **Registration** (`register`): builds one `MatterAccessory` per heating zone
  (device type `Thermostat`) and per hot water (device type `OnOffOutlet`),
  then calls `api.matter.registerPlatformAccessories(...)`. Before registering
  it unregisters any previously cached accessories — a deliberate workaround so
  that after a full Homebridge restart the endpoints are rebuilt fresh from the
  running Matter.js instance.
- **Command handlers**: `handlers.thermostat.systemModeChange` /
  `occupiedHeatingSetpointChange` and `handlers.onOff.on/off/toggle` map Home
  app actions to `HiveApi` calls. Homebridge's `HomebridgeThermostatServer`
  invokes these handler names when the corresponding attributes change.
- **State sync**: `updateHeating` / `updateHotWater` push the latest polled
  values back via `api.matter.updateAccessoryState(...)`.

### Why device types come from `api.matter.deviceTypes`

Matter.js identifies behaviours by class identity. If the plugin imported device
type definitions from its **own** dependency tree, those classes would be a
different module instance than the one Homebridge runs, producing errors such as
`identify is not a Behavior.Type`. Using `api.matter.deviceTypes.Thermostat`
(and `.OnOffOutlet`) guarantees the classes come from the running Homebridge
Matter instance. This was fixed earlier on the branch (commit `e2eca4b`).

### Hive → Matter mapping

- Heating zone → Matter **Thermostat**, presented as **heating-only**. The Home
  app derives its mode buttons from the thermostat cluster's **FeatureMap**, not
  from `ControlSequenceOfOperation`, so to show only Off/Heat (not Cool/Auto)
  the device type's supported features are restricted to Heating + Occupancy
  (see `heatingDeviceType()` in `matterPlatform.ts`). This also disables the
  Cooling, AutoMode and Presets features. Hive `OFF` ↔ Matter `Off`; any other
  Hive mode ↔ Matter `Heat`. `thermostatRunningMode` is not published because it
  requires the (now-disabled) AutoMode feature.
- Hot water → Matter **OnOffOutlet** used as a boost switch. On = start boost
  for the configured minutes; Off = return to the previous mode.
- Temperatures are Celsius × 100 (Matter's centidegree unit).

## 3. The bug that stopped Matter working

The heating thermostat **failed to commission**. The bridge-provided
`deviceTypes.Thermostat` is built with the feature set
`heating + cooling + autoMode + occupancy`, plus a **Presets feature whose state
varies between Homebridge / matter.js builds**. This turned out to be the whole
problem, and it bit from both directions:

- **Presets ENABLED** (e.g. the Raspberry Pi build): `presetTypes` MUST contain
  1–7 entries. An empty or absent array fails with:
  ```
  Validating ...thermostat.state.presetTypes:
    Constraint "1 to 7": Array length 0 is not within bounds (135)
  ```
- **Presets DISABLED** (the dev-machine build): `presetTypes` MUST NOT be set at
  all. Setting it fails with:
  ```
  Validating ...thermostat.state.presetTypes:
    Conformance "PRES": Matter does not allow you to set this attribute (135)
  ```

In every case initialization threw, Matter.js rolled the endpoint back, and the
thermostat never appeared on the network — so pairing/commands could not work.

Two further details mattered for the ENABLED case:
- The `presetTypes` struct has exactly three fields: `presetScenario`,
  `numberOfPresets`, `presetTypeFeatures`. An earlier `appliesToHvac` field was
  **not** valid.
- `presetTypeFeatures` is a Matter **bitmap**, so matter.js expects an object
  (`{}` for "no features"), not the numeric `0` used previously
  (`Cannot manage number because it is not a bitmap object`).

A secondary inefficiency: `updateHeating` re-sent the full cluster (including
the fixed setpoint limits and `controlSequenceOfOperation`) on every poll. Those
attributes are non-writable on the thermostat server and were silently reverted,
producing pointless transactions.

## 4. Diagnosis steps

Everything was validated against the **real** Matter.js runtime rather than by
guesswork:

1. **Confirmed the API surface exists** by reading
   `node_modules/homebridge/dist/matter/api.d.ts` and `types.d.ts`. The latter
   revealed the Thermostat device type's feature flags (and that `presets` can
   differ between builds).
2. **Read the Matter.js `ThermostatServer`**
   (`@matter/node/.../thermostat/ThermostatServer.js`) to understand which
   attributes are mandatory/forbidden under each feature and how setpoint-limit
   cross-checks behave when AutoMode is enabled.
3. **Read Homebridge's `AccessoryManager`**
   (`dist/matter/server/AccessoryManager.js`) to learn the exact registration
   contract: `new Endpoint(deviceType, { id: UUID, ...accessory.clusters })`.
4. **Located the feature flag** at `deviceType.defaults.thermostat.featureMap`
   so the plugin can detect Presets support at runtime.
5. **Confirmed the `presetTypes` struct** field names and the
   `presetTypeFeatures` bitmap shape against `@matter/types` and the live
   `Thermostat.PresetScenario` / `PresetTypeFeatures` enums.
6. **Dual-build end-to-end check with the real compiled plugin**: instantiated
   `HiveMatterPlatform` with a stub `MatterAPI` backed by Homebridge's real
   matter modules, then brought the captured accessories online on a real
   `ServerNode` exactly as `AccessoryManager` does — once on the local
   presets-DISABLED build, and once by feeding the plugin's exact emitted
   cluster into a presets-ENABLED thermostat. Both passed:

   ```
   [local build] presetsEnabled=false captured=2
     OK: Downstairs -> Thermostat
     OK: Hot Water -> OnOffPlugInUnit
     heating cluster has presetTypes? false
   [presets-ENABLED build] thermostat with plugin presetTypes -> initialized OK
   ALL CHECKS PASSED
   ```

## 5. The fix (`src/matterPlatform.ts`)

Static inspection of the device type turned out to be **insufficient on its
own**: the Presets feature can be added by Homebridge's runtime thermostat
behaviour, so a build can report `presets: false` on the device-type template
yet still require `presetTypes` at registration (this is what happens on the
Pi). Worse, `registerPlatformAccessories` only *emits* an event — the endpoint
initialization (and its validation failure) happens asynchronously afterwards,
so the failure cannot be caught with a `try/catch` around registration.

As of the heating-only change the Presets state is largely **deterministic**:
restricting the device type's features to Heating + Occupancy (see
`heatingDeviceType()`) makes Homebridge rebuild its `HomebridgeThermostatServer`
with `presets: false`, so `presetTypes` must be absent. The fix nonetheless
keeps a **self-healing retry** as a fallback for older Homebridge builds that
ignore the supplied feature set:

1. **Default the first guess to disabled** (`DEFAULT_PRESETS_ENABLED = false`),
   matching the heating-only feature set. We deliberately do *not* read the
   device-type template's feature flags — they proved misleading. On a build
   that honours the restricted features (current Homebridge 2.x), the common
   case succeeds on the first attempt with no `presetTypes`. A build that
   ignores the restriction and keeps its default preset-enabled thermostat
   server self-heals via the retry below.
2. **Self-healing registration** (`register()` → `registerWith()` +
   `verifyThermostats()`): register with the guess, then poll
   `getAccessoryState(uuid, 'thermostat')` for each zone. A thermostat whose
   endpoint failed validation never enters the live accessory map, so its state
   read stays `undefined`. If any thermostat doesn't come online within a short
   window, flip the Presets decision, re-register once, and verify again. This
   makes the plugin converge on the correct setting regardless of how (or
   whether) the feature can be detected.
2a. **Remembering the decision**: the value that successfully registered is
   persisted to `.hive-thermostat-matter.json` in the Homebridge storage path
   (`loadPersistedPresets()` / `savePersistedPresets()`). On subsequent
   restarts that remembered value is used as the initial guess, so even on a
   build that needs the non-default setting the failed first attempt (and its
   `Behaviors have errors` stack trace) only ever happens once. The self-healing
   retry remains the fallback, and it re-persists if the platform ever changes
   its requirement.
3. The preset entry, when included, uses the correct three-field struct
   (`presetScenario` / `numberOfPresets` / `presetTypeFeatures`) with
   `presetTypeFeatures: {}` (empty bitmap) — not the invalid numeric `0` or the
   non-existent `appliesToHvac` field.
4. **Trimmed `updateHeating`** to push only the runtime-mutable attributes:
   `localTemperature`, `occupiedHeatingSetpoint`, `systemMode`,
   `thermostatRunningMode`.

`npm run build` passes.

## 6. Verifying on the Raspberry Pi

```bash
cd ~
sudo rm -rf /home/homebridge/homebridge-hive-thermostat
git clone -b codex/matter-support https://github.com/florida117/Homebridge-Hive-Thermostat.git /tmp/hive-build
sudo cp -r /tmp/hive-build /home/homebridge/homebridge-hive-thermostat
sudo chown -R homebridge:homebridge /home/homebridge/homebridge-hive-thermostat
sudo hb-service shell
  cd /home/homebridge/homebridge-hive-thermostat && npm install && npm run build
  cd /var/lib/homebridge && npm install /home/homebridge/homebridge-hive-thermostat
  exit
sudo hb-service restart
```

Then confirm:

1. The Hive child bridge starts and Matter comes up on its configured port.
2. On current Homebridge 2.x the thermostats register on the first attempt
   (default Presets = enabled), with no `Behaviors have errors`.
3. On a build that needs the opposite setting you'll see a single
   `… did not register with Presets=…; retrying with Presets=…` warning followed
   by `… registered after retry …` — that is the self-healing working, and it
   happens at most once because the result is remembered.
4. The Hive accessories register **without** a final `Behaviors have errors` or
   `identify is not a Behavior.Type`.
5. Pair the bridge in Apple Home and change a thermostat target / toggle hot
   water boost. (If a write returns `HTTP 404`, that is the separate Hive
   write-host concern handled in `hiveApi.ts`, not a Matter issue.)
