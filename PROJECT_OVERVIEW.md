# Project overview

This folder contains `homebridge-hive-thermostat`, a TypeScript Homebridge dynamic platform plugin. Its purpose is to expose Hive heating zones and Hive hot water controls to Apple HomeKit through Homebridge, using Hive's cloud API rather than talking directly to the Hive hub on the local network.

The plugin is designed to work around Hive's own HomeKit bridge reliability problems by making Homebridge the HomeKit-facing bridge. Hive remains the source of truth for device state, schedules, modes, and commands.

## What it exposes

- Hive heating products become HomeKit `Thermostat` accessories.
- Hive hot water products become HomeKit `Switch` accessories.
- On Homebridge v2 with Matter enabled, Hive heating products also become Matter `Thermostat` accessories.
- On Homebridge v2 with Matter enabled, Hive hot water products also become Matter On/Off Outlet accessories for manual boost control.
- Offline Hive devices are surfaced as HomeKit communication failures, so Home shows `No Response` instead of stale values — as is everything, once Hive itself stops answering. Matter accessories are marked unreachable in the same cases.
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
| `src/timeout.ts` | Deadlines for every network call: `fetchWithTimeout()` for the plugin's own requests, `withTimeout()` for Cognito's. |
| `test/` | `node:test` suite, run against the compiled plugin in `dist/`. |
| `scripts/verify-matter.mjs` | Checks the Matter layer against a real Homebridge Matter server; CI runs it for each supported Homebridge release. |
| `tsconfig.json` | Strict TypeScript configuration. Builds `src/**/*.ts` to CommonJS JavaScript in `dist/`. |
| `README.md` | User-facing installation and setup instructions. |
| `CHANGELOG.md` | Release history. |

## Runtime flow

1. Homebridge loads `dist/index.js`.
2. `src/index.ts` registers a platform named `HiveThermostat` from `src/platform.ts`.
3. Homebridge constructs `HiveThermostatPlatform` with the user's config.
4. The platform waits for Homebridge's `DID_FINISH_LAUNCHING` event before starting.
   It first binds handlers to the accessories restored from Homebridge's cache,
   so they report `No Response` — and refuse writes — until Hive has answered,
   rather than serving the values cached at the last shutdown.
5. The platform authenticates with Hive. If Hive cannot be reached (Homebridge
   often starts before the network after a power cut), it retries with backoff
   from 30 seconds up to 30 minutes.
6. It fetches all Hive nodes from the Hive cloud API.
7. It registers, restores, updates, or removes cached HomeKit accessories.
8. If Homebridge Matter is enabled and plugin Matter support is not disabled, it registers corresponding Matter accessories.
9. It starts polling Hive periodically and pushes fresh state into HomeKit and Matter.

If step 6 fails — a timeout, a Hive outage, an expired session — discovery is
left incomplete and retried on the next poll, because nothing else wires Hive
product ids to accessory handlers: without it every later poll would have
nowhere to deliver state.

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
   A refresh that fails only because Hive or Cognito could not be reached is
   retried with the same token instead — falling through to a login would text
   the user a 2FA code they did not ask for.
4. If Hive requires SMS MFA, log a clear setup prompt.
5. The user enters the SMS code into the Homebridge config field `smsCode` and restarts Homebridge.
6. The plugin submits that SMS code, receives tokens, and stores the refresh token for future restarts.

Only the refresh token is persisted, with the username it belongs to: Cognito's
refresh flow does not check the account, so a token from a previous account
would otherwise be honoured silently after the username changed. (Files from
1.0.9 and earlier have no username and are trusted.) The file is written with
mode `0600` where possible.

Failures are classified by `isTransientAuthError()`. Anything without a Cognito
`…Exception` code — a network failure, a timeout, the SSO page not loading — and
Cognito's own service errors are retried; a verdict on the account (a wrong
password, a revoked token, a rejected 2FA code) is not, since repeating a wrong
password counts towards Cognito's lockout. Every Cognito call has a 15-second
deadline (`withTimeout()`), because `amazon-cognito-identity-js` makes its
requests with none.

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
https://beekeeper.hivehome.com/1.0/nodes/{type}/{id}
```

If that host answers `403` or `404` — the gateway's way of saying it does not
route the request — the client retries the regional
`https://beekeeper-uk.hivehome.com/1.0` host before surfacing the error.

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
| `BOOST` | Shown as the mode the zone returns to when the boost ends (read from Hive), or `HEAT` when Hive does not say. |

Thermostat values:

- Current temperature comes from Hive product props.
- Target temperature comes from Hive product state.
- Current heating state is `HEAT` when Hive says the zone is actively working, otherwise `OFF`.
- Temperature bounds are 5-32 C with 0.5 C steps.

Setting a target temperature on a zone that is on its schedule sends only the
target, so the zone stays on the schedule and Hive treats it as an override
until the next scheduled change (this is what pyhiveapi sends). In any other
mode — boosting included — it sends `MANUAL` with the target.

## Matter mapping

Matter support is implemented in `src/matterPlatform.ts` and uses Homebridge v2's optional `api.matter` API. Matter accessories are only registered when Homebridge reports Matter as enabled for the current bridge and the plugin config field `enableMatter` is not `false`.

Heating zones are represented as Matter Thermostats:

| Hive mode | Matter system mode |
| --- | --- |
| `OFF` | `Off` |
| `MANUAL` | `Heat` |
| `SCHEDULE` | `Auto` |

Temperatures are converted from Hive Celsius values to Matter centi-degrees Celsius. Matter writes to `occupiedHeatingSetpoint` go through the same target-temperature call as HomeKit, with the same schedule behaviour.

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

Both reads and commands recover from an expired Cognito session: a 401 raises
`TokenExpiredError`, the platform refreshes the tokens once and replays the
request. Refreshes are single-flight, so a poll and a command that both hit a
401 share one. Commands run through the platform's own `setHeatingMode` /
`setHeatingTarget` / `setHotWaterBoost` / `cancelHotWaterBoost` wrappers rather
than touching `HiveApi` directly, so HomeKit and Matter share that recovery.
A refresh token that is rejected outright is reported once at error level and
thereafter at debug, since polling continues and the failure is permanent until
the user re-authenticates.

After three polls in a row fail, every accessory is reported unreachable —
HomeKit `No Response`, Matter `reachable: false` — until the next successful
poll. Hive's per-device `online` flag only covers a device dropping off Hive's
own network; without this, an outage of Hive itself (or a revoked session)
would leave the last values on show as though they were live.

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

The package targets Homebridge v2 and Node.js 22, 24 or 26 (`engines.node`).

Useful commands:

```bash
npm run build
npm run watch
npm run lint
npm test
```

`npm run build` removes `dist/` and runs the TypeScript compiler. The package entry point is `dist/index.js`.

`npm test` builds, then runs the `node:test` suite in `test/` against
`dist/`. HomeKit is exercised through real HAP-NodeJS characteristics; Matter
through a model of Homebridge's MatterAPI that, like the real one, applies
updates a tick later and calls the plugin's thermostat handlers only when an
attribute actually changes. CI runs it on every supported Node version, and the
release workflow runs it before anything is published.

`scripts/verify-matter.mjs` goes further than that model can: it runs the
Matter layer against a real Homebridge Matter server and real matter.js
endpoints, across a restart from cache. It reaches into Homebridge's internal
modules, so it is not part of `npm test`; CI runs it against every supported
Homebridge release (2.2.1, 2.3.1 and 2.4.0) instead. Run it locally after any
change to `src/matterPlatform.ts` — the header of the script says how to point
it at another release.

## Releasing

A release is cut by pushing a `v*` tag; `.github/workflows/publish.yml` does the
rest. Before tagging:

1. Bump `version` in `package.json` (`npm version <v> --no-git-tag-version`,
   which updates `package-lock.json` too).
2. Add a `## [<version>] - <date>` section to `CHANGELOG.md`. The workflow
   extracts it with `.github/scripts/extract-changelog.sh` and uses it as the
   GitHub Release body — which is where the Homebridge UI reads its "what's
   new" text from, so it is user-facing.
3. Commit, then push the commit *and* the tag.

Everything that can reject a release runs before `npm publish`, because that
step cannot be undone: the tag/version match, the trusted-publisher check and
the changelog extraction all gate it.

The workflow has two jobs. `build` installs dependencies, builds, runs the
gates and packs the tarball; `publish` downloads that tarball and publishes it.
Only `publish` holds `id-token: write`, and GitHub exposes the OIDC request
credentials to *every* step of a job that has it — so anything running there
can mint a real publish credential for this package. `npm publish` would
normally run the `prepare`/`prepublishOnly` scripts, putting `rimraf` and `tsc`
(and their dependency trees) inside that job. Publishing a finished tarball
avoids it: npm skips lifecycle scripts for a tarball spec, so the `publish` job
installs nothing and runs no third-party code. `npm pack --ignore-scripts` in
`build` is what makes the tarball publishable that way, and it also means the
project is built exactly once per release.

### Publishing credentials

There are none. The workflow publishes via **npm trusted publishing (OIDC)**:
npm mints a short-lived credential from GitHub's identity for each run, so
there is no token in the repository secrets to rotate or expire. (The previous
`NPM_PUBLISH_TOKEN` expired at npm's 90-day limit between 1.0.5 and 1.0.6 and
broke that release.)

This depends on state held on npmjs.com rather than in this repository — a
trusted publisher registered under the package's *Settings → Trusted Publisher*:

| Field | Value |
| --- | --- |
| Organization or user | `florida117` |
| Repository | `Homebridge-Hive-Thermostat` |
| Workflow filename | `publish.yml` |
| Environment | *(empty)* |

**Allowed actions** must include direct publishing. Trusted publishers created
after 2026-09-03 default to permitting `npm stage publish` only, and a release
then fails with `403 OIDC permission denied for this action` — npm trusts the
workflow's identity but not the action it is attempting. This is separate from
the configuration above and cannot be checked in advance: the registry API that
exposes allowed actions requires package-write permission behind an interactive
2FA challenge, which no CI job can satisfy. The publish step recognises that
specific rejection and prints the fix.

⚠️ The link is bound to the **workflow filename**. Renaming `publish.yml`, or
moving the publish into a reusable workflow, silently invalidates it. npm
reports a mismatch only as `ENEEDAUTH: This command requires you to be logged
in`, with the real reason logged at `verbose` and discarded — which is why
`.github/scripts/check-trusted-publisher.mjs` performs the same token exchange
up front and prints what npm actually said.

## Important implementation details

- The plugin depends on Hive cloud access. It does not work locally against a Hive hub.
- The Hive SSO page and Beekeeper API are unofficial integration points and could change.
- A browser-like `User-Agent` is sent because Hive rejects some non-browser-looking requests.
- Offline handling intentionally raises HomeKit communication failures to avoid misleading stale device state.
- Hot water control is intentionally modeled as boost control, not as a full schedule editor.
