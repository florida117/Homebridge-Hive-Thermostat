const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const settings = require('../dist/settings');
const { HiveAuth } = require('../dist/hiveAuth');
const { HiveApi } = require('../dist/hiveApi');
const { HiveThermostatPlatform } = require('../dist/platform');
const h = require('./helpers');

const { hap } = h;
const TOKENS = { idToken: 'id', accessToken: 'access', refreshToken: 'refresh-2' };
const COMMUNICATION_FAILURE = hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
const realFetch = globalThis.fetch;

beforeEach(() => {
  settings.STARTUP_RETRY_MIN_MS = 10;
});

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = realFetch;
});

function cognitoError(code) {
  return Object.assign(new Error(code), { code, name: code });
}

function networkError() {
  return Object.assign(new Error('Network error'), { code: 'NetworkError' });
}

/**
 * Stub Hive: `refresh` and `login` stand in for Cognito, `getState` for the
 * Beekeeper read. Each records its calls.
 */
function stubHive({
  refresh = async () => TOKENS,
  login = async () => TOKENS,
  getState = async () => ({ zones: [h.zone()], hotWater: [h.hotWater()] }),
} = {}) {
  return {
    refresh: mock.method(HiveAuth.prototype, 'refreshFromToken', refresh),
    login: mock.method(HiveAuth.prototype, 'login', login),
    getState: mock.method(HiveApi.prototype, 'getState', getState),
  };
}

/** Construct the platform and let Homebridge finish launching. */
function launch(t, { stored, cached = [] } = {}) {
  const storagePath = h.tempStorage();
  const tokenFile = path.join(storagePath, '.hive-thermostat-tokens.json');
  if (stored) {
    fs.writeFileSync(tokenFile, JSON.stringify(stored));
  }
  const homebridge = h.createHomebridge({ storagePath });
  const log = h.createLog();
  const platform = new HiveThermostatPlatform(
    log,
    {
      platform: 'HiveThermostat',
      username: 'me@example.com',
      password: 'secret',
      enableMatter: false,
    },
    homebridge,
  );
  for (const accessory of cached) {
    platform.configureAccessory(accessory);
  }
  homebridge.emit('didFinishLaunching');
  t.after(() => homebridge.emit('shutdown'));
  return { platform, homebridge, log, tokenFile };
}

function heatingAccessory(homebridge, accessories = homebridge.registered) {
  const uuid = hap.uuid.generate('hive-heating-zone-1');
  return accessories.find((a) => a.UUID === uuid);
}

function characteristic(accessory, type) {
  return accessory.getService(hap.Service.Thermostat).getCharacteristic(type);
}

const discovered = (homebridge) => () => homebridge.registered.length === 2;

// ---- Startup ----------------------------------------------------------------

test('a network failure at startup is retried with the stored token, not a fresh login', async (t) => {
  let attempts = 0;
  const hive = stubHive({
    refresh: async () => {
      if (attempts++ === 0) {
        throw networkError();
      }
      return TOKENS;
    },
  });
  const { homebridge, log } = launch(t, { stored: { refreshToken: 'stored', username: 'me@example.com' } });

  await h.until(discovered(homebridge));

  assert.equal(hive.refresh.mock.callCount(), 2);
  assert.equal(hive.login.mock.callCount(), 0);
  assert.ok(log.messages('warn').some((m) => m.includes('Retrying in')));
});

test('a rejected password is reported, not retried', async (t) => {
  const hive = stubHive({
    login: async () => {
      throw cognitoError('NotAuthorizedException');
    },
  });
  const { log } = launch(t);

  await h.until(() => log.messages('error').length > 0);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(hive.login.mock.callCount(), 1);
  assert.match(log.messages('error')[0], /Hive startup failed: NotAuthorizedException/);
});

test('a revoked refresh token falls back to a fresh login, and the new token is stored', async (t) => {
  const hive = stubHive({
    refresh: async () => {
      throw cognitoError('NotAuthorizedException');
    },
  });
  const { homebridge, tokenFile } = launch(t, { stored: { refreshToken: 'revoked' } });

  await h.until(discovered(homebridge));

  assert.equal(hive.login.mock.callCount(), 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(tokenFile, 'utf8')), {
    refreshToken: 'refresh-2',
    username: 'me@example.com',
  });
});

test('a session stored for a different account is not used', async (t) => {
  const hive = stubHive();
  const { homebridge } = launch(t, {
    stored: { refreshToken: 'theirs', username: 'someone@example.com' },
  });

  await h.until(discovered(homebridge));

  assert.equal(hive.refresh.mock.callCount(), 0);
  assert.equal(hive.login.mock.callCount(), 1);
});

test('a session stored before usernames were recorded is still used', async (t) => {
  const hive = stubHive();
  const { homebridge } = launch(t, { stored: { refreshToken: 'legacy' } });

  await h.until(discovered(homebridge));

  assert.deepEqual(hive.refresh.mock.calls[0].arguments, ['legacy']);
  assert.equal(hive.login.mock.callCount(), 0);
});

// ---- Accessory state --------------------------------------------------------

test('cached accessories report No Response, and refuse writes, until Hive answers', async (t) => {
  stubHive({ refresh: () => new Promise(() => {}) });
  const cached = new (h.createHomebridge().platformAccessory)(
    'Downstairs',
    hap.uuid.generate('hive-heating-zone-1'),
  );
  cached.context.hiveId = 'zone-1';
  launch(t, { stored: { refreshToken: 'stored' }, cached: [cached] });

  await assert.rejects(
    characteristic(cached, hap.Characteristic.CurrentTemperature).handleGetRequest(),
    (status) => status === COMMUNICATION_FAILURE,
  );
  await assert.rejects(
    characteristic(cached, hap.Characteristic.TargetTemperature).handleSetRequest(21),
    (status) => status === COMMUNICATION_FAILURE,
  );
});

test('accessories go unreachable after repeated failed polls, and recover', async (t) => {
  const hive = stubHive();
  const { platform, homebridge, log } = launch(t, { stored: { refreshToken: 'stored' } });
  await h.until(discovered(homebridge));
  const temperature = characteristic(heatingAccessory(homebridge), hap.Characteristic.CurrentTemperature);
  assert.equal(await temperature.handleGetRequest(), 19);

  hive.getState.mock.mockImplementation(async () => {
    throw new Error('Hive nodes/all failed: HTTP 503');
  });
  for (let poll = 1; poll < settings.STALE_AFTER_FAILED_POLLS; poll++) {
    await platform.pollOnce();
  }
  assert.equal(await temperature.handleGetRequest(), 19, 'still live before the threshold');

  await platform.pollOnce();
  await assert.rejects(temperature.handleGetRequest(), (status) => status === COMMUNICATION_FAILURE);
  assert.ok(log.messages('warn').some((m) => m.includes('reporting accessories as unreachable')));

  hive.getState.mock.mockImplementation(async () => ({
    zones: [h.zone({ currentTemperature: 20.5 })],
    hotWater: [h.hotWater()],
  }));
  await platform.pollOnce();
  assert.equal(await temperature.handleGetRequest(), 20.5);
});

test('a poll and a command that both need a refresh share one', async (t) => {
  const hive = stubHive();
  const { platform, homebridge } = launch(t, { stored: { refreshToken: 'stored' } });
  await h.until(discovered(homebridge));
  const before = hive.refresh.mock.callCount();

  const results = await Promise.all([platform.refreshTokens(), platform.refreshTokens()]);

  assert.deepEqual(results, [true, true]);
  assert.equal(hive.refresh.mock.callCount(), before + 1);
});

test('a temperature change on the schedule keeps the zone on its schedule', async (t) => {
  stubHive();
  const writes = [];
  globalThis.fetch = async (url, init) => {
    writes.push(JSON.parse(init.body));
    return new Response('{}', { status: 200 });
  };
  const { homebridge } = launch(t, { stored: { refreshToken: 'stored' } });
  await h.until(discovered(homebridge));
  const accessory = heatingAccessory(homebridge);

  await characteristic(accessory, hap.Characteristic.TargetTemperature).handleSetRequest(21);

  assert.deepEqual(writes, [{ target: 21 }]);
  assert.equal(
    await characteristic(accessory, hap.Characteristic.TargetHeatingCoolingState).handleGetRequest(),
    hap.Characteristic.TargetHeatingCoolingState.AUTO,
  );
});
