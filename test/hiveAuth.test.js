const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  HiveAuthActionRequired,
  HiveSmsRequired,
  isTransientAuthError,
} = require('../dist/hiveAuth');
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
