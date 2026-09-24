/**
 * Fail a release BEFORE `npm publish` if npm will not accept this workflow's
 * identity.
 *
 * Publishing uses trusted publishing (OIDC), so there is no token to check:
 * the credential is minted per run and only npm can say whether it trusts the
 * caller. That answer normally arrives at the publish step — too late, because
 * the tag is public by then — and it arrives badly. npm's OIDC helper is
 * documented "intended to never throw" and logs every rejection at `verbose`
 * only, so a misconfigured trusted publisher surfaces as a bare
 * `ENEEDAUTH: This command requires you to be logged in`, with the real reason
 * discarded.
 *
 * So ask the same question npm asks, early, and report what it actually said.
 * This mirrors npm/lib/utils/oidc.js: request a GitHub ID token for the
 * registry's audience, then POST it to the registry's token-exchange endpoint.
 * The exchange returns a real (short-lived) publish credential, so nothing
 * here prints the response body.
 *
 * ⚠️ Scope of this check: it proves npm recognises this repository and
 * workflow as a trusted publisher for the package. It does NOT prove the
 * publish will be allowed. Which *actions* a trusted publisher may perform
 * (`npm stage publish` only, or direct `npm publish` too) is separate
 * configuration, and the registry reveals it only by accepting or rejecting
 * the publish itself: the API that exposes it requires package-write
 * permission behind an interactive 2FA challenge, which no CI job can satisfy
 * and the OIDC credential is not scoped for. A release can therefore pass this
 * check and still fail with `403 OIDC permission denied for this action` —
 * the publish step recognises that specific rejection and explains it.
 */

import { readFileSync } from 'node:fs';

const REGISTRY = 'https://registry.npmjs.org';

const fail = (message, detail) => {
  console.error(`\n✗ ${message}\n`);
  if (detail) {
    console.error(`${detail}\n`);
  }
  process.exit(1);
};

const { name } = JSON.parse(readFileSync('package.json', 'utf8'));

const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
if (!requestUrl || !requestToken) {
  fail(
    'GitHub did not expose an OIDC token endpoint to this job.',
    'The job needs `permissions: id-token: write`. Without it npm silently\n' +
      'skips OIDC entirely and then fails as though nobody were logged in.',
  );
}

// The audience is `npm:<registry hostname>` — npm derives it the same way.
const audience = `npm:${new URL(REGISTRY).hostname}`;
const tokenUrl = new URL(requestUrl);
tokenUrl.searchParams.set('audience', audience);

const tokenResponse = await fetch(tokenUrl, {
  headers: { Accept: 'application/json', Authorization: `Bearer ${requestToken}` },
});
if (!tokenResponse.ok) {
  fail(`GitHub refused to issue an ID token (HTTP ${tokenResponse.status}).`);
}
const idToken = (await tokenResponse.json()).value;
if (!idToken) {
  fail('GitHub returned an ID token response with no value.');
}

// Same endpoint npm posts to. A 200 means npm recognises this repository and
// workflow as a trusted publisher for the package.
const exchangeUrl = new URL(
  `/-/npm/v1/oidc/token/exchange/package/${encodeURIComponent(name)}`,
  REGISTRY,
);
const exchange = await fetch(exchangeUrl, {
  method: 'POST',
  headers: { Authorization: `Bearer ${idToken}` },
});

if (!exchange.ok) {
  // Safe to surface: this is the rejection, not the credential.
  let reason = '';
  try {
    reason = (await exchange.json())?.message ?? '';
  } catch {
    /* no JSON body — the status code is the whole answer */
  }
  fail(
    `npm rejected this workflow's identity for "${name}" (HTTP ${exchange.status}).` +
      (reason ? `\n  npm said: ${reason}` : ''),
    'Check the trusted publisher at https://www.npmjs.com/package/' +
      `${name}/access — every field must match this workflow exactly:\n` +
      `  Organization or user : ${(process.env.GITHUB_REPOSITORY ?? '/').split('/')[0]}\n` +
      `  Repository           : ${(process.env.GITHUB_REPOSITORY ?? '/').split('/')[1]}\n` +
      `  Workflow filename    : ${(process.env.GITHUB_WORKFLOW_REF ?? '').split('/').pop()?.split('@')[0] || 'publish.yml'}\n` +
      '  Environment          : must be empty unless this job declares one\n\n' +
      'Renaming this file breaks the link — the trusted publisher is bound to\n' +
      'the workflow filename, not just the repository.',
  );
}

console.log(
  `✓ npm recognises this workflow as a trusted publisher for "${name}".\n` +
    '  (Whether it may publish directly is decided at publish time — see above.)',
);
