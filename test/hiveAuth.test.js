const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  HiveAuth,
  HiveAuthActionRequired,
  HiveSmsRequired,
  isTransientAuthError,
} = require('../dist/hiveAuth');
const h = require('./helpers');
const { Buffer } = require('node:buffer');
const { HiveTimeoutError, withTimeout } = require('../dist/timeout');

function cognitoError(code) {
  return Object.assign(new Error(code), { code, name: code });
}

test('failures that never reached a verdict on the credentials are transient', () => {
  for (const err of [
    Object.assign(new Error('Network error'), { code: 'NetworkError' }),
    new TypeError('fetch failed'),
    new HiveTimeoutError('Hive login', 15_000),
    new Error('Failed to fetch Hive SSO config: HTTP 503'),
    cognitoError('InternalErrorException'),
    cognitoError('TooManyRequestsException'),
  ]) {
    assert.equal(isTransientAuthError(err), true, err.message);
  }
});

test('verdicts on the account or token are not', () => {
  for (const err of [
    cognitoError('NotAuthorizedException'),
    cognitoError('UserNotFoundException'),
    cognitoError('CodeMismatchException'),
    cognitoError('PasswordResetRequiredException'),
    new HiveSmsRequired(),
    new HiveAuthActionRequired('Set a new password.'),
  ]) {
    assert.equal(isTransientAuthError(err), false, err.message);
  }
});

test('withTimeout passes a prompt result through', async () => {
  assert.equal(await withTimeout(Promise.resolve(42), 'answer', 50), 42);
});

test('withTimeout rejects a call that never settles', async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 'Hive session refresh', 20),
    (err) => err instanceof HiveTimeoutError && /Hive session refresh timed out/.test(err.message),
  );
});

// ---- Refresh and the Cognito device ----------------------------------------
//
// Cognito itself is faked at the HTTP level: the SDK posts to the pool's
// endpoint with global fetch, so the request it builds can be inspected.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function jwt(claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({ iat: now, exp: now + 3600, ...claims })}.sig`;
}

/** Fake the Hive SSO page and Cognito, recording each Cognito call. */
function fakeCognito() {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith('https://sso.hivehome.com')) {
      return new Response(
        '<script>window.HiveSSOPoolId = "eu-west-1_pool"; ' +
          'window.HiveSSOPublicCognitoClientId = "client123";</script>',
      );
    }
    calls.push({ target: init.headers['X-Amz-Target'], body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      AuthenticationResult: { IdToken: jwt(), AccessToken: jwt({ username: 'cognito-user' }) },
    }));
  };
  return calls;
}

const DEVICE = { username: 'cognito-user', key: 'eu-west-1_dev', groupKey: 'group', password: 'device-secret' };

test('a refresh after a restart sends the stored device key with the token', async () => {
  const calls = fakeCognito();
  const auth = new HiveAuth('me@example.com', 'secret', h.createLog());

  const tokens = await auth.refreshFromToken('stored-refresh', DEVICE);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, 'AWSCognitoIdentityProviderService.InitiateAuth');
  assert.deepEqual(calls[0].body.AuthParameters, {
    REFRESH_TOKEN: 'stored-refresh',
    DEVICE_KEY: 'eu-west-1_dev',
  });
  // Cognito does not rotate the refresh token here; the stored one carries on.
  assert.equal(tokens.refreshToken, 'stored-refresh');
  assert.deepEqual(auth.device(), DEVICE);
});

test('a later refresh in the same process keeps sending the device key', async () => {
  const calls = fakeCognito();
  const auth = new HiveAuth('me@example.com', 'secret', h.createLog());

  await auth.refreshFromToken('stored-refresh', DEVICE);
  await auth.refreshFromToken('stored-refresh');

  assert.equal(calls[1].body.AuthParameters.DEVICE_KEY, 'eu-west-1_dev');
});

test('without a stored device, no device key is invented', async () => {
  const calls = fakeCognito();
  const auth = new HiveAuth('me@example.com', 'secret', h.createLog());

  await auth.refreshFromToken('stored-refresh');

  assert.deepEqual(calls[0].body.AuthParameters, { REFRESH_TOKEN: 'stored-refresh' });
  assert.equal(auth.device(), undefined);
});

test('each plugin instance keeps its own Cognito state', async () => {
  fakeCognito();
  const first = new HiveAuth('me@example.com', 'secret', h.createLog());
  const second = new HiveAuth('me@example.com', 'secret', h.createLog());

  await first.refreshFromToken('stored-refresh', DEVICE);
  await second.refreshFromToken('stored-refresh');

  assert.equal(second.device(), undefined);
});
