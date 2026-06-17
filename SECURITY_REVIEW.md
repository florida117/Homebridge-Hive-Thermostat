# Security review and remediation

Review date: 2026-06-04

This document records the security investigation and the fixes applied to this repository. The review covered dependency advisories, credential handling, token storage, logging, Hive network calls, and package metadata.

## Remediation summary

The issues found in the initial review have been addressed:

| Area | Status | Change |
| --- | --- | --- |
| Vulnerable `js-cookie` transitive dependency | Fixed | Added an npm override forcing `js-cookie` to `3.0.8`; regenerated `package-lock.json`. |
| Refresh-token file permissions | Fixed | Added an explicit `chmod(0600)` after writing the token file. |
| SMS MFA code visibility | Fixed | Updated the Homebridge config UI layout so `smsCode` renders as a password-style field. |
| Hive API calls without timeout | Fixed | Added `fetchWithTimeout()` and routed Hive SSO/API fetches through it. |
| Raw failed-write response logging | Fixed | Sanitized and truncated failed Hive write response bodies before including them in errors. |
| Lockfile package version mismatch | Fixed | Regenerated `package-lock.json`; root version now matches `package.json`. |
| Generated files accidentally appearing in git | Fixed | Added `.gitignore` entries for `node_modules/`, `dist/`, and `.DS_Store`. |

## Dependency vulnerability: fixed

Original finding:

- `amazon-cognito-identity-js@6.3.16` depends on `js-cookie@^2.2.1`.
- The lockfile previously resolved `js-cookie` to `2.2.1`.
- `npm audit` reported GHSA-qjx8-664m-686j against `js-cookie <=3.0.5`.

Fix:

```json
"overrides": {
  "js-cookie": "3.0.8"
}
```

After regenerating the lockfile, `package-lock.json` resolves `node_modules/js-cookie` to `3.0.8`.

Verification:

```bash
npm audit
```

Result:

```text
found 0 vulnerabilities
```

## Token storage hardening: fixed

The plugin stores a Hive refresh token in Homebridge's storage path at `.hive-thermostat-tokens.json`. That token can be used to create a new Hive session without another SMS challenge.

The original code used `fs.writeFile(..., { mode: 0o600 })`, which is helpful for first creation but may not tighten permissions if the file already exists. The code now explicitly calls:

```ts
await fs.chmod(this.tokenStorePath, 0o600);
```

This keeps the token owner-readable/writeable only after every save attempt.

## SMS code handling: fixed

The Homebridge schema already masked the Hive password, but `smsCode` was rendered as a normal field. The schema layout now renders `smsCode` as:

```json
{
  "key": "smsCode",
  "type": "password"
}
```

The SMS code is short-lived, and users should still clear it after successful setup, but the UI no longer displays it as ordinary visible text.

## Hive fetch timeouts: fixed

Hive SSO and Beekeeper API calls now use `src/fetchWithTimeout.ts`. The helper applies a 15-second timeout to `node-fetch` requests so startup, polling, and command handling do not hang indefinitely on stalled network calls.

Covered calls:

- Hive SSO config discovery in `src/hiveAuth.ts`.
- Hive state polling in `src/hiveApi.ts`.
- Hive command writes in `src/hiveApi.ts`.

## Error logging hygiene: fixed

Failed Hive state writes used to include the full response body in the thrown error. The code now normalizes whitespace and truncates the body to 300 characters before including it.

This preserves useful diagnostics while reducing the chance of leaking unexpected third-party response details into Homebridge logs.

## Package hygiene: fixed

`package.json` was at version `0.2.1`, while `package-lock.json` still recorded root version `0.1.0`. The lockfile has been regenerated and now matches the current package version, `0.3.0`.

A `.gitignore` file has also been added so local install/build artifacts are not accidentally committed:

```text
node_modules/
dist/
.DS_Store
```

## Verification performed

Commands run:

```bash
npm install --package-lock-only
npm install
npm audit
npm run build
```

Results:

- `npm audit`: `found 0 vulnerabilities`
- `npm run build`: passed

Note: this machine is currently using Node.js `v26.0.0`. `homebridge` and `hap-nodejs` emitted engine warnings because they declare support through Node 24, but the TypeScript build still completed successfully.

## Remaining operational recommendations

- Run the plugin on a Homebridge-supported Node.js version, ideally Node 22 or Node 24 until Homebridge declares Node 26 support.
- After first-time Hive SMS setup, clear `smsCode` from the Homebridge config.
- Treat the Homebridge storage directory as sensitive because it contains the Hive refresh token.
