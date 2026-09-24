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

- Heating zone → Matter **Thermostat**, using Homebridge's bridge-provided
  Thermostat device type (Heating + Cooling + AutoMode + Occupancy). The Home app
  derives its mode buttons from the thermostat cluster's **FeatureMap**, so it
  shows Off/Cool/Heat/Auto. Hive cannot cool, so `controlSequenceOfOperation` is
  `HeatingOnly`: the Cool button still appears but matter.js *rejects* a Cool
  selection (`SystemMode Cool is not allowed with ControlSequenceOfOperation
  HeatingOnly`), making it inert. Mode mapping: Hive `OFF` ↔ Matter `Off`; Hive
  `SCHEDULE` ↔ Matter `Auto` (Matter has no schedule mode, so Auto drives the
  Hive schedule); any other Hive mode (`MANUAL`/`BOOST`) ↔ Matter `Heat`.
  This matches the HAP thermostat, which likewise maps Auto → schedule.
  `thermostatRunningMode` is published (valid because the AutoMode feature is
  present) to convey heat/off running state.
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

## 5. The design (`src/matterPlatform.ts`)

### 5.1 Three Homebridge regimes, each detected rather than guessed

Static inspection of the device-type template was misleading on its own, and so
was a fixed default: what matters is how the *live* endpoint ends up composed,
and that differs by Homebridge generation. `composeThermostat()` identifies the
regime from an observable property, never a version string:

| Regime | Detected by | Cluster features live | `presetTypes` |
| --- | --- | --- | --- |
| Homebridge >= 2.4.0 | `api.matter.deviceRequirements` exists | composed by the plugin: Heating, Cooling, AutoMode | must be absent |
| Homebridge 2.3.x | bare `deviceTypes.Thermostat` | detected from the declared setpoints: Heating, Cooling, AutoMode | must be absent |
| Homebridge <= 2.2.x | `deviceTypes.Thermostat.behaviors.thermostat` is already set | matter.js `ThermostatServer` defaults: Heating, Cooling, Occupancy, AutoMode, **Presets** | must hold 1–7 entries |

On 2.3.x there is no way to override the detected features, and none is needed:
`detectThermostatFeatures()` reads the declared setpoints, so declaring a
cooling setpoint alongside the heating one yields exactly the set the plugin
composes explicitly on 2.4.0.

### 5.2 The cooling half, and why it cannot be dropped

Hive only heats, but the Matter spec conforms HEAT and COOL as `"AUTO, O.a+"` —
AutoMode requires **both**. AutoMode is what carries the Hive schedule (Matter
has no schedule mode), so the cooling half is declared everywhere:

- `occupiedCoolingSetpoint` is pinned to the top of the range, and
  `controlSequenceOfOperation` is `HeatingOnly`, so cooling stays inert.
- The cooling **limits** use the spec's own 16–32 °C `AbsMin/MaxCoolSetpointLimit`
  range rather than Hive's 5–32 °C heating range. matter.js does not enforce it
  (`constraint: "desc"`), but a stricter controller may, and a 5 °C cooling floor
  on a boiler is a fiction with no upside.
- ⚠️ `minSetpointDeadBand: 0` is mandatory. AutoMode brings the deadband, and
  matter.js >= 0.17.7 validates the whole cluster:
  `max/minCoolSetpointLimit - max/minHeatSetpointLimit >= minSetpointDeadBand`.
  An undeclared deadband defaults to 2.0 °C, which against a 32 °C top on both
  sides gives `3200 - 3200 = 0` and fails. The symptom is badly disconnected
  from the cause: registration succeeds, then *every* later setpoint update is
  rejected with "Thermostat setpoints could not be reconciled within the
  configured limits".

`occupancy` is deliberately **not** declared. Where the feature is not composed
it is rejected outright (`Conformance "OCC"`), and where it *is* composed
(<= 2.2.x) matter.js initialises it to `{ occupied: true }` itself when the node
comes online, so every setpoint still routes through the Occupied attributes.

### 5.3 Handlers

Homebridge's `HomebridgeThermostatServer` routes four thermostat operations to
plugin handlers, and `BehaviorRegistry.executeHandler()` **throws** when one is
missing — an unregistered handler is a hard `Status.Failure` to the controller,
not a silent no-op. All four are registered:

- `systemModeChange` → Hive mode (Off / schedule / manual).
- `occupiedHeatingSetpointChange` → `setHeatingTarget`.
- `occupiedCoolingSetpointChange` → repairs the endpoint. Cooling is live on
  every generation, so a controller can write this setpoint, and matter.js then
  reconciles the pair and drags the **heating** setpoint down with it (see 5.4).
- `setpointRaiseLower` → applies the delta (0.1 °C steps) to the heating target,
  clamped to the Hive range. A Cool-only adjustment is left alone here:
  Homebridge runs matter.js's own implementation after the handler returns, so
  the cooling setpoint it moves is repaired by the handler above.

### 5.4 ⚠️ Homebridge hands the plugin its own writes back

There is no local-actor guard anywhere in the chain: `HomebridgeThermostatServer`
reacts to attribute *changes*, and matter.js does not distinguish a write made
by the plugin (`updateAccessoryState` → `endpoint.set()`) from one made by a
controller. Every value a poll pushes therefore arrives back at this plugin's
own handlers, which would forward it to Hive as a user request — and
`setHeatingTarget()` sends `mode: MANUAL`, so a temperature change made *by the
Hive schedule* would echo back and switch the zone off that schedule.

The plugin records each value it is about to write (`expectEcho()`) and
consumes the matching callback (`isEcho()`). A second guard covers the deadband
drag: writing the cooling setpoint makes matter.js move the heating setpoint
inside the same transaction, reported as an ordinary heating change. The
originating attribute commits first, so `occupiedCoolingSetpointChange` always
runs before the heating change it causes and can mark it as collateral
(`reconcilingSetpoints`), dropping the marker on the next tick.

Both guards fail safe: the worst case is a redundant command to Hive that is
skipped, never a wrong one that is sent.

### 5.5 `updateHeating()` writes systemMode separately

matter.js reacts to a `systemMode` change by forcing `thermostatRunningMode` to
match it (`ThermostatServer#handleSystemModeChange`), and that reaction has
already run by the time the write resolves. Sending both in one payload loses
the running mode *permanently*, because the change-detection cache records the
payload that was intended rather than what the endpoint kept — a zone switched
to MANUAL with the boiler idle would report "heating" until the next restart.

So the mode goes in its own write first, and when it actually lands the cache
entry for the rest of the payload is dropped, forcing the corrective write even
though it is byte-identical to the previous poll's.

### 5.6 Registration is verified, and a wrong decision self-heals

`registerPlatformAccessories` only *emits* an event — endpoint initialization
(and its validation failure) happens asynchronously afterwards, so a failure
cannot be caught with a `try/catch` around registration. `verifyThermostats()`
polls `getAccessoryState(uuid, 'thermostat')` instead: a thermostat whose
endpoint failed validation never enters the live accessory map, so its state
read never succeeds. (Where that method does not exist there is nothing to
observe, and verification is skipped rather than burning the deadline.)

The feature set is derived rather than guessed, so this normally just confirms
a healthy start in ~100 ms. It is still wired to a **one-shot retry**: the one
thing the derivation cannot cover is a Homebridge generation that does not exist
yet. If the Presets decision were wrong, matter.js would reject the endpoint and
that thermostat would stay unreadable for the life of the process; flipping the
one derived bit and re-registering turns a dead accessory back into a working
one. Unlike the 1.0.4 design, nothing is persisted — the decision is re-derived
every start, so there is no stale file and no remembered wrong answer.

Matter registration is also wrapped at its call site in `platform.ts`: it is the
last thing `discoverDevices()` does, so an exception there would otherwise leave
the poll timer unarmed and cost the user their plain HomeKit accessories over a
Matter-only problem.

### 5.7 Verifying changes locally

Conformance failures surface as a whole endpoint silently failing to come
online, so they are easy to ship. Prove a change instead of reasoning about it:
build a `ServerNode` from `@matter/main`, compose the device type the way
`AccessoryManager` does, add an `Endpoint` carrying the plugin's declared
cluster state, and see whether it initialises. `checkThermostatSetpointLimits()`
and `detectThermostatFeatures()` from `homebridge/dist/matter/serverHelpers.js`
are plain exported functions and can be run directly against the accessory the
plugin produces. Drive it from an `.mjs` script (`homebridge` is ESM, the plugin
compiles to CJS — use `createRequire` for `dist/`), give each `ServerNode` a
unique id and its own port, and clean up `~/.matter/<id>` afterwards.

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
2. The startup line `Hive: Matter thermostat — <regime> (Presets=<bool>)` names
   the regime that was detected, and the thermostats register on the first
   attempt with no `Behaviors have errors`.
3. A `… did not come online with Presets=…; Retrying once …` warning followed by
   `… online with Presets=…` means the derivation met a Homebridge generation it
   does not know about and recovered. That is worth a bug report, with the
   Homebridge version — the retry is a safety net, not the intended path.
4. The Hive accessories register **without** a final `Behaviors have errors` or
   `identify is not a Behavior.Type`.
5. Pair the bridge in Apple Home and change a thermostat target / toggle hot
   water boost. (If a write returns `HTTP 404`, that is the separate Hive
   write-host concern handled in `hiveApi.ts`, not a Matter issue.)
