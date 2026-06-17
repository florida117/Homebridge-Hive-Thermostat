# Project overview

This folder contains `homebridge-hive-thermostat`, a TypeScript Homebridge dynamic platform plugin. Its purpose is to expose Hive heating zones and Hive hot water controls to Apple HomeKit through Homebridge, using Hive's cloud API rather than talking directly to the Hive hub on the local network.

The plugin is designed to work around Hive's own HomeKit bridge reliability problems by making Homebridge the HomeKit-facing bridge. Hive remains the source of truth for device state, schedules, modes, and commands.

## What it exposes

- Hive heating products become HomeKit `Thermostat` accessories.
- Hive hot water products become HomeKit `Switch` accessories.
- On Homebridge v2 with Matter enabled, Hive heating products also become Matter `Thermostat` accessories.
- On Homebridge v2 with Matter enabled, Hive hot water products also become Matter On/Off Outlet accessories for manual boost control.
- Offline Hive devices are surfaced as HomeKit communication failures, so Home shows `No Response` instead of stale values.
- HomeKit changes are sent back to Hive through the Beekeeper API, then confirmed by a short follow-up poll.

## Main files

| File | Purpose |
| --- | --- |
| `package.json` | npm/Homebridge metadata, runtime dependencies, and build scripts. |
| `config.schema.json` | Homebridge UI schema for username, password, SMS code, polling, and hot water boost duration. |
| `src/index.ts` | Homebridge plugin entry point. Registers the dynamic platform. |
| `src/settings.ts` | Shared constants: plugin name, platform name, Hive URLs, poll interval limits, and thermostat temperature bounds. |
| `src/platform.ts` | Core Homebridge platform lifecycle: authentication, token persistence, discovery, accessory registration, polling, and token refresh. |
| `src/hiveAuth.ts` | AWS Cognito SRP login flow for Hive, including SMS MFA and refresh-token login. |
| `src/hiveApi.ts` | Thin client for Hive's Beekeeper API. Fetches and normalizes state, and posts command changes. |
| `src/heatingAccessory.ts` | Maps each Hive heating zone to a HomeKit thermostat service. |
| `src/hotWaterAccessory.ts` | Maps each Hive hot water product to a HomeKit switch service for timed boost control. |
| `src/matterPlatform.ts` | Registers and updates optional Homebridge v2 Matter accessories. |
| `tsconfig.json` | Strict TypeScript configuration. Builds `src/**/*.ts` to CommonJS JavaScript in `dist/`. |
| `README.md` | User-facing installation and setup instructions. |
| `CHANGELOG.md` | Release history. |

## Runtime flow

1. Homebridge loads `dist/index.js`.
2. `src/index.ts` registers a platform named `HiveThermostat` from `src/platform.ts`.
3. Homebridge constructs `HiveThermostatPlatform` with the user's config.
4. The platform waits for Homebridge's `DID_FINISH_LAUNCHING` event before starting.
5. The platform authenticates with Hive.
6. It fetches all Hive nodes from the Hive cloud API.
7. It registers, restores, updates, or removes cached HomeKit accessories.
8. If Homebridge Matter is enabled and plugin Matter support is not disabled, it registers corresponding Matter accessories.
9. It starts polling Hive periodically and pushes fresh state into HomeKit and Matter.

On Homebridge shutdown, the platform clears its interval and one-shot timers.

## Authentication

Hive login is handled in `src/hiveAuth.ts` with `amazon-cognito-identity-js`.

The plugin does not hardcode Hive's Cognito user pool or public client ID. Instead, it fetches `https://sso.hivehome.com/` and parses the login page for:

- `HiveSSOPoolId`
- `HiveSSOPublicCognitoClientId`

The login sequence is:

1. Try to load a stored refresh token from Homebridge storage at `.hive-thermostat-tokens.json`.
2. If that works, refresh the Cognito session silently.
3. If no refresh token exists, or Hive rejects it, perform a username/password login.
4. If Hive requires SMS MFA, log a clear setup prompt.
5. The user enters the SMS code into the Homebridge config field `smsCode` and restarts Homebridge.
6. The plugin submits that SMS code, receives tokens, and stores the refresh token for future restarts.

Only the refresh token is persisted. The file is written with mode `0600` where possible.

## Hive API layer

`src/hiveApi.ts` talks to Hive's Beekeeper API.

State is fetched from:

```text
https://beekeeper.hivehome.com/1.0/nodes/all?products=true&devices=true&actions=true
```

The response contains products and devices. Product entries contain heating and hot water state. Device entries contain online/offline status. The API layer combines those into normalized objects:

- `HiveHeatingZone`
- `HiveHotWater`
- `HiveState`

Commands are posted to:

```text
https://beekeeper-uk.hivehome.com/1.0/nodes/{type}/{id}
```

If Hive returns `404 NOT_FOUND` on that host, the client retries the legacy
`https://beekeeper.hivehome.com/1.0` host before surfacing the error.

Supported writes are:

- Set heating target temperature.
- Set heating mode.
- Set hot water mode.
- Start a timed hot water boost.
- Cancel a hot water boost and return to the previous mode.

If Hive returns HTTP `401`, `HiveApi` throws `TokenExpiredError`. The platform catches that and attempts a token refresh.

## HomeKit mapping

### Heating

Each Hive heating product is represented as a HomeKit `Thermostat`.

Hive mode mapping:

| Hive mode | HomeKit target state |
| --- | --- |
| `OFF` | `OFF` |
| `MANUAL` | `HEAT` |
| `SCHEDULE` | `AUTO` |
| `BOOST` | Treated as `HEAT`, with the underlying mode normalized in the API layer where available. |

Thermostat values:

- Current temperature comes from Hive product props.
- Target temperature comes from Hive product state.
- Current heating state is `HEAT` when Hive says the zone is actively working, otherwise `OFF`.
- Temperature bounds are 5-32 C with 0.5 C steps.

Setting a target temperature from HomeKit changes the Hive zone to `MANUAL` mode.

## Matter mapping

Matter support is implemented in `src/matterPlatform.ts` and uses Homebridge v2's optional `api.matter` API. Matter accessories are only registered when Homebridge reports Matter as enabled for the current bridge and the plugin config field `enableMatter` is not `false`.

Heating zones are represented as Matter Thermostats:

| Hive mode | Matter system mode |
| --- | --- |
| `OFF` | `Off` |
| `MANUAL` | `Heat` |
| `SCHEDULE` | `Heat` |
| `BOOST` | `Heat` |

Temperatures are converted from Hive Celsius values to Matter centi-degrees Celsius. Matter writes to `occupiedHeatingSetpoint` call the Hive target-temperature API and therefore put the zone into Hive `MANUAL` mode.

The Matter thermostat uses Homebridge's bridge-provided thermostat endpoint type
so it shares the same Matter.js module instance as the running bridge. Hive does
not expose Matter-style thermostat presets, so the plugin avoids publishing
their attributes and keeps Hive schedule editing out of scope.

Hot water is represented as a Matter On/Off Outlet:

- Matter `on`: start a Hive hot water boost for `hotWaterDurationMinutes`.
- Matter `off`: cancel the boost and return to the previous Hive mode.
- Matter `toggle`: switches between those two actions based on the last known Hive boost state.

Matter does not expose Hive schedule editing. Hive schedule mode is represented as Matter `Auto`.

### Hot water

Each Hive hot water product is represented as a HomeKit `Switch`.

The switch specifically represents a manual hot water boost:

- Switch `on`: start a Hive `BOOST` for `hotWaterDurationMinutes`.
- Switch `off`: cancel the boost and return to the previous Hive mode, usually `SCHEDULE`.

Scheduled hot water activity does not turn the switch on. The switch reflects whether a manual boost is active.

Hive often gives hot water the same name as a heating zone, so the plugin appends `Hot Water` to the accessory name unless it is already present.

## Discovery and accessory identity

The platform is a Homebridge dynamic platform. It restores cached accessories through `configureAccessory()` so HomeKit identities survive restarts.

For each discovered Hive product, it creates a stable HomeKit UUID:

- Heating: `hive-heating-{id}`
- Hot water: `hive-hotwater-{id}`

If a Hive product has disappeared, the platform unregisters the stale Homebridge accessory. If a Hive product has been renamed, the cached accessory display name is updated.

## Polling behavior

The default poll interval is 15 seconds. The configured minimum is also 15 seconds, so user config cannot poll Hive more aggressively than that. The Homebridge schema allows up to 300 seconds.

After HomeKit sends a command, the plugin schedules a one-off poll about 4 seconds later. Repeated quick commands collapse into a single follow-up poll. This lets HomeKit reflect the confirmed Hive state without waiting for the next regular polling interval.

## Configuration

The plugin is configured as a Homebridge platform:

```json
{
  "platform": "HiveThermostat",
  "name": "Hive Thermostat",
  "username": "you@example.com",
  "password": "your-hive-password",
  "pollInterval": 15,
  "hotWaterDurationMinutes": 30
}
```

Available config fields:

| Field | Meaning |
| --- | --- |
| `name` | Display name for the platform configuration. |
| `username` | Hive account email address. |
| `password` | Hive account password. |
| `smsCode` | Temporary first-time SMS MFA code. Can be cleared after successful setup. |
| `pollInterval` | Poll interval in seconds. Minimum 15. |
| `hotWaterDurationMinutes` | Duration of a manual hot water boost. |
| `enableMatter` | Whether to register Matter accessories when Homebridge Matter is enabled. Defaults to `true`. |

## Build and development

The package targets Homebridge v2 and Node.js versions supported by Homebridge v2 Matter, currently Node 22 or Node 24.

Useful commands:

```bash
npm run build
npm run watch
npm run lint
```

`npm run build` removes `dist/` and runs the TypeScript compiler. The package entry point is `dist/index.js`.

There are currently no automated tests defined in `package.json`.

## Important implementation details

- The plugin depends on Hive cloud access. It does not work locally against a Hive hub.
- The Hive SSO page and Beekeeper API are unofficial integration points and could change.
- A browser-like `User-Agent` is sent because Hive rejects some non-browser-looking requests.
- Offline handling intentionally raises HomeKit communication failures to avoid misleading stale device state.
- Hot water control is intentionally modeled as boost control, not as a full schedule editor.
