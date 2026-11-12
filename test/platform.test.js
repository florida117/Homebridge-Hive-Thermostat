const { test, beforeEach, afterEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const settings = require('../dist/settings');
const { HiveAuth } = require('../dist/hiveAuth');
const { HiveApi } = require('../dist/hiveApi');
const { HiveThermostatPlatform } = require('../dist/platform');
const h = require('./helpers');

const { hap } = h;
const { HiveTimeoutError } = require('../dist/timeout');
const TOKENS = { idToken: 'id', accessToken: 'access', refreshToken: 'refresh-2' };
const COMMUNICATION_FAILURE = hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
const realFetch = globalThis.fetch;

const { STARTUP_RETRY_MIN_MS, CODE_WATCH_INTERVAL_MS } = settings;
beforeEach(() => {
  settings.STARTUP_RETRY_MIN_MS = 10;
  settings.CODE_WATCH_INTERVAL_MS = 5;
});
after(() => {
  settings.STARTUP_RETRY_MIN_MS = STARTUP_RETRY_MIN_MS;
  settings.CODE_WATCH_INTERVAL_MS = CODE_WATCH_INTERVAL_MS;
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
function launch(t, { stored, challenge, cached = [], config = {} } = {}) {
  const storagePath = h.tempStorage();
  const tokenFile = path.join(storagePath, '.hive-thermostat-tokens.json');
  const challengeFile = path.join(storagePath, '.hive-thermostat-2fa.json');
  if (stored) {
    fs.writeFileSync(tokenFile, JSON.stringify(stored));
  }
  if (challenge) {
    fs.writeFileSync(challengeFile, JSON.stringify(challenge));
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
      ...config,
    },
    homebridge,
  );
  for (const accessory of cached) {
    platform.configureAccessory(accessory);
  }
  homebridge.emit('didFinishLaunching');
  t.after(() => homebridge.emit('shutdown'));
  /** Save a 2FA code in config.json, as the Homebridge UI does. */
  const saveCode = (smsCode) =>
    fs.writeFileSync(
      path.join(storagePath, 'config.json'),
      JSON.stringify({
        bridge: {},
        platforms: [
          { platform: 'Other', username: 'me@example.com', smsCode: '000000' },
          { platform: 'HiveThermostat', username: 'Me@Example.com', password: 'secret', smsCode },
        ],
      }),
    );
  return { platform, homebridge, log, tokenFile, challengeFile, saveCode };
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

  assert.equal(hive.refresh.mock.calls[0].arguments[0], 'legacy');
  assert.equal(hive.login.mock.callCount(), 0);
});

// ---- Cognito device ---------------------------------------------------------

const DEVICE = { username: 'cognito-user', key: 'eu-west-1_dev', groupKey: 'group', password: 'device-secret' };

test('the Cognito device is stored with the refresh token and handed back on restart', async (t) => {
  const hive = stubHive();
  mock.method(HiveAuth.prototype, 'device', () => DEVICE);
  const { homebridge, tokenFile } = launch(t, {
    stored: { refreshToken: 'stored', username: 'me@example.com', device: DEVICE },
  });

  await h.until(discovered(homebridge));

  assert.deepEqual(hive.refresh.mock.calls[0].arguments, ['stored', DEVICE]);
  assert.equal(hive.login.mock.callCount(), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(tokenFile, 'utf8')), {
    refreshToken: 'refresh-2',
    username: 'me@example.com',
    device: DEVICE,
  });
  assert.equal((fs.statSync(tokenFile).mode & 0o777).toString(8), '600');
});

test('an incomplete stored device is ignored rather than sent', async (t) => {
  const hive = stubHive();
  const { homebridge } = launch(t, {
    stored: { refreshToken: 'stored', device: { ...DEVICE, password: undefined } },
  });

  await h.until(discovered(homebridge));

  assert.deepEqual(hive.refresh.mock.calls[0].arguments, ['stored', undefined]);
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

test('a login that times out is not retried, since each attempt can text a 2FA code', async (t) => {
  const hive = stubHive({
    login: async () => {
      throw new HiveTimeoutError('Hive login', 15_000);
    },
  });
  const { log } = launch(t);

  await h.until(() => log.messages('error').length > 0);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(hive.login.mock.callCount(), 1);
  assert.match(log.messages('error')[0], /Hive login timed out.*restart Homebridge/);
});

// ---- 2FA ---------------------------------------------------------------------
//
// Cognito accepts a code only for the login that sent it, and every login
// sends a new code. So a code is always checked against the stored challenge,
// never sent to a fresh login.

const { HiveSmsRequired } = require('../dist/hiveAuth');

function challengeFrom(session) {
  return { username: 'cognito-user', session, type: 'SMS_MFA', destination: '+********1234' };
}

/** Logins each raise a new challenge: s1, s2, … */
function stubSmsLogin(submit = async () => TOKENS) {
  let logins = 0;
  const hive = stubHive({
    login: async () => {
      throw new HiveSmsRequired(challengeFrom(`s${++logins}`));
    },
  });
  hive.submit = mock.method(HiveAuth.prototype, 'submitSms', submit);
  return hive;
}

const submitted = (hive) => hive.submit.mock.calls.map((c) => [c.arguments[0], c.arguments[1].session]);

test('a code saved in the config after the SMS is checked against that login, without a restart', async (t) => {
  const hive = stubSmsLogin();
  // The code from an earlier login is still in the config, as in issue #1.
  const { homebridge, log, tokenFile, challengeFile, saveCode } =
    launch(t, { config: { smsCode: '111111' } });

  await h.until(() => fs.existsSync(challengeFile));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(hive.submit.mock.callCount(), 0, 'the stale code is never submitted');
  assert.ok(log.messages('warn').some((m) => m.includes('sent to +********1234') && m.includes('no need to restart')));

  saveCode(' 222 222 ');
  await h.until(discovered(homebridge));

  assert.deepEqual(submitted(hive), [['222222', 's1']]);
  assert.equal(hive.login.mock.callCount(), 1);
  assert.equal(fs.existsSync(challengeFile), false);
  assert.equal(JSON.parse(fs.readFileSync(tokenFile, 'utf8')).refreshToken, 'refresh-2');
});

test('the 2FA challenge is stored privately', async (t) => {
  stubSmsLogin();
  const { challengeFile } = launch(t);

  await h.until(() => fs.existsSync(challengeFile));

  const stored = JSON.parse(fs.readFileSync(challengeFile, 'utf8'));
  assert.equal(stored.challenge.session, 's1');
  assert.equal(stored.username, 'me@example.com');
  assert.equal(fs.statSync(challengeFile).mode & 0o777, 0o600);
});

test('a restart with the code in the config answers the stored login instead of starting another', async (t) => {
  const hive = stubSmsLogin();
  const { homebridge } = launch(t, {
    config: { smsCode: '222222' },
    challenge: { username: 'me@example.com', challenge: challengeFrom('s-before-restart'), sentAt: Date.now() - 60_000, staleCode: '111111' },
  });

  await h.until(discovered(homebridge));

  assert.equal(hive.login.mock.callCount(), 0, 'no new SMS is sent');
  assert.deepEqual(submitted(hive), [['222222', 's-before-restart']]);
});

test('a restart while still waiting for the code does not text another one', async (t) => {
  const hive = stubSmsLogin();
  const { log, saveCode, homebridge } = launch(t, {
    config: { smsCode: '111111' },
    challenge: { username: 'me@example.com', challenge: challengeFrom('s1'), sentAt: Date.now() - 60_000, staleCode: '111111' },
  });

  await h.until(() => log.messages('info').some((m) => m.includes('still waiting for the 2FA code')));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(hive.login.mock.callCount(), 0);
  assert.equal(hive.submit.mock.callCount(), 0);

  saveCode('222222');
  await h.until(discovered(homebridge));
  assert.deepEqual(submitted(hive), [['222222', 's1']]);
});

test('a stored challenge past Cognito\'s limit, or for another account, starts a new login', async (t) => {
  for (const challenge of [
    { username: 'me@example.com', challenge: challengeFrom('old'), sentAt: Date.now() - 16 * 60_000 },
    { username: 'someone@else.com', challenge: challengeFrom('theirs'), sentAt: Date.now() },
  ]) {
    mock.restoreAll();
    const hive = stubSmsLogin();
    const { challengeFile } = launch(t, { challenge });

    await h.until(() => hive.login.mock.callCount() === 1);
    await h.until(() => JSON.parse(fs.readFileSync(challengeFile, 'utf8')).challenge.session === 's1');
  }
});

test('a wrong code is reported and a corrected one is accepted on the same login', async (t) => {
  const hive = stubSmsLogin(async (code) => {
    if (code !== '222222') {
      throw cognitoError('CodeMismatchException');
    }
    return TOKENS;
  });
  const { homebridge, log, saveCode } = launch(t);
  await h.until(() => hive.login.mock.callCount() === 1);

  saveCode('999999');
  await h.until(() => log.messages('error').some((m) => /2FA code rejected/.test(m)));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(hive.submit.mock.callCount(), 1, 'a rejected code is not resent');

  saveCode('222222');
  await h.until(discovered(homebridge));
  assert.deepEqual(submitted(hive), [['999999', 's1'], ['222222', 's1']]);
  assert.equal(hive.login.mock.callCount(), 1);
});

test('a code for an expired login sends a new one, and that one is accepted', async (t) => {
  const hive = stubSmsLogin(async (_code, challenge) => {
    if (challenge.session === 's1') {
      throw cognitoError('NotAuthorizedException');
    }
    return TOKENS;
  });
  const { homebridge, log, saveCode } = launch(t);
  await h.until(() => hive.login.mock.callCount() === 1);

  saveCode('222222');
  await h.until(() => hive.login.mock.callCount() === 2);
  assert.ok(log.messages('warn').some((m) => m.includes('expired')));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(hive.submit.mock.callCount(), 1, 'the expired code is not tried on the new login');

  saveCode('333333');
  await h.until(discovered(homebridge));
  assert.deepEqual(submitted(hive), [['222222', 's1'], ['333333', 's2']]);
});

test('a 2FA code that could not be submitted is retried, not sent to a fresh login', async (t) => {
  let attempts = 0;
  const hive = stubSmsLogin(async () => {
    if (attempts++ === 0) {
      throw networkError();
    }
    return TOKENS;
  });
  const { homebridge, log, saveCode } = launch(t);
  await h.until(() => hive.login.mock.callCount() === 1);

  saveCode('222222');
  await h.until(discovered(homebridge));

  assert.equal(hive.login.mock.callCount(), 1);
  assert.deepEqual(submitted(hive), [['222222', 's1'], ['222222', 's1']]);
  assert.ok(log.messages('warn').some((m) => /could not submit the 2FA code/.test(m)));
});

test('without credentials, cached accessories still report No Response', async (t) => {
  stubHive();
  const cached = new (h.createHomebridge().platformAccessory)(
    'Downstairs',
    hap.uuid.generate('hive-heating-zone-1'),
  );
  cached.context.hiveId = 'zone-1';
  launch(t, { cached: [cached], config: { password: '' } });

  await assert.rejects(
    characteristic(cached, hap.Characteristic.CurrentTemperature).handleGetRequest(),
    (status) => status === COMMUNICATION_FAILURE,
  );
});

test('a product missing from a successful poll is reported unreachable', async (t) => {
  const hive = stubHive();
  const { platform, homebridge } = launch(t, { stored: { refreshToken: 'stored' } });
  await h.until(discovered(homebridge));
  const temperature = characteristic(heatingAccessory(homebridge), hap.Characteristic.CurrentTemperature);

  hive.getState.mock.mockImplementation(async () => ({ zones: [], hotWater: [h.hotWater()] }));
  await platform.pollOnce();

  await assert.rejects(temperature.handleGetRequest(), (status) => status === COMMUNICATION_FAILURE);
});

// ---- Radiator valves --------------------------------------------------------

function valveAccessory(homebridge, accessories = homebridge.registered) {
  const uuid = hap.uuid.generate('hive-heating-trv-room-1');
  return accessories.find((a) => a.UUID === uuid);
}

function battery(accessory, type) {
  return accessory.getService(hap.Service.Battery).getCharacteristic(type);
}

test('a radiator valve room is a thermostat with a battery, written to its own node', async (t) => {
  stubHive({
    getState: async () => ({ zones: [h.zone(), h.radiatorValve({ battery: 15 })], hotWater: [] }),
  });
  const writes = [];
  globalThis.fetch = async (url, init) => {
    writes.push([new URL(url).pathname, JSON.parse(init.body)]);
    return new Response('{}', { status: 200 });
  };
  const { homebridge, log } = launch(t, { stored: { refreshToken: 'stored' } });
  await h.until(discovered(homebridge));
  const valve = valveAccessory(homebridge);

  assert.equal(valve.context.hiveType, 'trvcontrol');
  assert.equal(
    valve.getService(hap.Service.AccessoryInformation).getCharacteristic(hap.Characteristic.Model).value,
    'Radiator Valve',
  );
  assert.equal(await battery(valve, hap.Characteristic.BatteryLevel).handleGetRequest(), 15);
  assert.equal(
    await battery(valve, hap.Characteristic.StatusLowBattery).handleGetRequest(),
    hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
  );
  assert.equal(heatingAccessory(homebridge).getService(hap.Service.Battery), undefined);
  assert.ok(log.messages('info').some((m) => m.includes('Discovered radiator valve "Bedroom"')));

  await characteristic(valve, hap.Characteristic.TargetTemperature).handleSetRequest(21);
  await characteristic(valve, hap.Characteristic.TargetHeatingCoolingState)
    .handleSetRequest(hap.Characteristic.TargetHeatingCoolingState.OFF);

  assert.deepEqual(writes, [
    ['/1.0/nodes/trvcontrol/trv-room-1', { target: 21 }],
    ['/1.0/nodes/trvcontrol/trv-room-1', { mode: 'OFF' }],
  ]);
});

test('a radiator valve with no battery reading gets no Battery service, rather than a false 0%', async (t) => {
  const hive = stubHive({
    getState: async () => ({ zones: [h.zone(), h.radiatorValve({ battery: undefined })], hotWater: [] }),
  });
  const { platform, homebridge } = launch(t, { stored: { refreshToken: 'stored' } });
  await h.until(discovered(homebridge));
  const valve = valveAccessory(homebridge);

  assert.equal(valve.getService(hap.Service.Battery), undefined);

  hive.getState.mock.mockImplementation(async () => ({
    zones: [h.zone(), h.radiatorValve({ battery: 70 })],
    hotWater: [],
  }));
  await platform.pollOnce();
  assert.equal(await battery(valve, hap.Characteristic.BatteryLevel).handleGetRequest(), 70);

  // A later poll without a reading keeps the last real one.
  hive.getState.mock.mockImplementation(async () => ({
    zones: [h.zone(), h.radiatorValve({ battery: undefined })],
    hotWater: [],
  }));
  await platform.pollOnce();
  assert.equal(await battery(valve, hap.Characteristic.BatteryLevel).handleGetRequest(), 70);
  assert.equal(
    await battery(valve, hap.Characteristic.StatusLowBattery).handleGetRequest(),
    hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
  );
});

test('a cached radiator valve is reused as one, keeping its Battery service and node', async (t) => {
  stubHive({
    getState: async () => ({ zones: [h.radiatorValve()], hotWater: [] }),
  });
  const writes = [];
  globalThis.fetch = async (url) => {
    writes.push(new URL(url).pathname);
    return new Response('{}', { status: 200 });
  };
  const cached = new (h.createHomebridge().platformAccessory)(
    'Bedroom',
    hap.uuid.generate('hive-heating-trv-room-1'),
  );
  Object.assign(cached.context, { hiveId: 'trv-room-1', hiveType: 'trvcontrol' });
  cached.addService(hap.Service.Battery);
  const { homebridge, log } = launch(t, { stored: { refreshToken: 'stored' }, cached: [cached] });
  await h.until(() => log.messages('info').some((m) => m.includes('Discovered radiator valve')));

  assert.equal(homebridge.registered.length, 0, 'the cached accessory is reused');
  assert.equal(await battery(cached, hap.Characteristic.BatteryLevel).handleGetRequest(), 80);
  await characteristic(cached, hap.Characteristic.TargetTemperature).handleSetRequest(21);
  assert.deepEqual(writes, ['/1.0/nodes/trvcontrol/trv-room-1']);
});

// ---- Plugs, lights and sensors ----------------------------------------------

function plug(overrides = {}) {
  return { id: 'plug-1', type: 'activeplug', name: 'Lamp', online: true, on: false, ...overrides };
}

function light(overrides = {}) {
  return {
    id: 'light-1', type: 'colourtuneablelight', name: 'Lounge', online: true, on: true, brightness: 80,
    colourTemperature: 2700, colourTemperatureRange: { min: 2700, max: 6535 },
    colourMode: 'WHITE', hue: 45, saturation: 65, ...overrides,
  };
}

function sensor(overrides = {}) {
  return { id: 'sensor-1', type: 'contactsensor', name: 'Back Door', online: true, triggered: false, battery: 80, ...overrides };
}

function byUuid(homebridge, name) {
  return homebridge.registered.find((a) => a.UUID === hap.uuid.generate(name));
}

/** Launch with plugs, lights and sensors on the account; records Hive writes. */
async function launchDevices(t, state = {}, config = {}) {
  const hive = stubHive({
    getState: async () => ({
      zones: [], hotWater: [], plugs: [plug()], lights: [light()], sensors: [sensor()], ...state,
    }),
  });
  const writes = [];
  globalThis.fetch = async (url, init) => {
    writes.push([new URL(url).pathname, JSON.parse(init.body)]);
    return new Response('{}', { status: 200 });
  };
  const launched = launch(t, { stored: { refreshToken: 'stored' }, config });
  await h.until(() => launched.log.messages('info').some((m) => m.startsWith('Discovered')));
  await h.settle();
  return { ...launched, hive, writes };
}

test('a plug is an Outlet whose switch writes its own node', async (t) => {
  const { homebridge, writes } = await launchDevices(t);
  const outlet = byUuid(homebridge, 'hive-plug-plug-1').getService(hap.Service.Outlet);

  assert.equal(await outlet.getCharacteristic(hap.Characteristic.On).handleGetRequest(), false);
  await outlet.getCharacteristic(hap.Characteristic.On).handleSetRequest(true);

  assert.deepEqual(writes, [['/1.0/nodes/activeplug/plug-1', { status: 'ON' }]]);
});

test('a light dims in Hive\'s 5% steps and converts colour temperature to kelvin', async (t) => {
  const { homebridge, writes } = await launchDevices(t);
  const bulb = byUuid(homebridge, 'hive-light-light-1').getService(hap.Service.Lightbulb);
  const set = (type, value) => bulb.getCharacteristic(type).handleSetRequest(value);

  await set(hap.Characteristic.Brightness, 37);
  await set(hap.Characteristic.Brightness, 1);
  await set(hap.Characteristic.Brightness, 0);
  await set(hap.Characteristic.ColorTemperature, 250);

  assert.deepEqual(writes.map(([, body]) => body), [
    { status: 'ON', brightness: 35 },
    { status: 'ON', brightness: 5 },
    // Zero sends nothing: the On write that comes with it turns the light off.
    { colourMode: 'WHITE', colourTemperature: 4000 },
  ]);
  const range = bulb.getCharacteristic(hap.Characteristic.ColorTemperature).props;
  assert.deepEqual([range.minValue, range.maxValue], [153, 370]);
});

test('a light\'s hue and saturation reach Hive as one write', async (t) => {
  const { homebridge, writes } = await launchDevices(t);
  const bulb = byUuid(homebridge, 'hive-light-light-1').getService(hap.Service.Lightbulb);

  await Promise.all([
    bulb.getCharacteristic(hap.Characteristic.Hue).handleSetRequest(200),
    bulb.getCharacteristic(hap.Characteristic.Saturation).handleSetRequest(90),
  ]);

  assert.deepEqual(writes, [[
    '/1.0/nodes/colourtuneablelight/light-1',
    { colourMode: 'COLOUR', hue: '200', saturation: '90', value: '100' },
  ]]);
});

test('a dimmable light has no colour controls, and a colour light has all of them', async (t) => {
  const { homebridge } = await launchDevices(t, {
    lights: [light({ id: 'warm', type: 'warmwhitelight', colourTemperature: undefined }), light()],
  });
  const has = (name, type) =>
    byUuid(homebridge, name).getService(hap.Service.Lightbulb).testCharacteristic(type);

  assert.equal(has('hive-light-warm', hap.Characteristic.ColorTemperature), false);
  assert.equal(has('hive-light-warm', hap.Characteristic.Hue), false);
  assert.equal(has('hive-light-light-1', hap.Characteristic.ColorTemperature), true);
  assert.equal(has('hive-light-light-1', hap.Characteristic.Hue), true);
});

test('sensors report contact and motion, with a battery', async (t) => {
  const { homebridge } = await launchDevices(t, {
    sensors: [sensor({ triggered: true }), sensor({ id: 'motion-1', type: 'motionsensor', triggered: true, battery: 10 })],
  });
  const contact = byUuid(homebridge, 'hive-sensor-sensor-1');
  const motion = byUuid(homebridge, 'hive-sensor-motion-1');

  assert.equal(
    await contact.getService(hap.Service.ContactSensor)
      .getCharacteristic(hap.Characteristic.ContactSensorState).handleGetRequest(),
    hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
  );
  assert.equal(
    await motion.getService(hap.Service.MotionSensor)
      .getCharacteristic(hap.Characteristic.MotionDetected).handleGetRequest(),
    true,
  );
  assert.equal(
    await motion.getService(hap.Service.Battery)
      .getCharacteristic(hap.Characteristic.StatusLowBattery).handleGetRequest(),
    hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
  );
});

test('a kind of device turned off in the config is left out, and removed if cached', async (t) => {
  const cached = new (h.createHomebridge().platformAccessory)('Lounge', hap.uuid.generate('hive-light-light-1'));
  Object.assign(cached.context, { hiveId: 'light-1', hiveType: 'colourtuneablelight' });
  stubHive({
    getState: async () => ({ zones: [], hotWater: [], plugs: [plug()], lights: [light()], sensors: [sensor()] }),
  });
  const { homebridge, log } = launch(t, {
    stored: { refreshToken: 'stored' },
    cached: [cached],
    config: { enableLights: false },
  });
  await h.until(() => log.messages('info').some((m) => m.startsWith('Discovered plug')));
  await h.settle();

  assert.ok(!log.messages('info').some((m) => m.startsWith('Discovered light')));
  assert.deepEqual(homebridge.unregistered, [cached]);
  assert.ok(byUuid(homebridge, 'hive-plug-plug-1'));
  assert.ok(byUuid(homebridge, 'hive-sensor-sensor-1'));
});
