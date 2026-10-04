const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const matterModule = require('../dist/matterPlatform');
const { HiveMatterPlatform } = matterModule;
const h = require('./helpers');

const HEATING = 'hive-matter-heating-zone-1';
const HOT_WATER = 'hive-matter-hotwater-hw-1';
const SystemMode = { Off: 0, Auto: 1, Heat: 4 };

beforeEach(() => {
  matterModule.VERIFY_DEADLINE_MS = 300;
});

/**
 * A registered Matter platform that has seen two identical polls — the
 * steady state every bug below starts from.
 */
async function setup({
  regime,
  rejects,
  zones = [h.zone()],
  hotWater = [h.hotWater()],
  cached = [],
  restored = cached,
} = {}) {
  const fake = h.createMatter({ regime, rejects });
  const log = h.createLog();
  const { sent, commands } = h.recordCommands();
  const platform = new HiveMatterPlatform(
    { isMatterEnabled: () => true, matter: fake.matter },
    log,
    commands,
    30,
  );
  for (const accessory of restored) {
    fake.restore(accessory);
  }
  for (const accessory of cached) {
    platform.configureAccessory(accessory);
  }
  await platform.register({ zones, hotWater });
  for (let poll = 0; poll < 2; poll++) {
    for (const z of zones) {
      await platform.updateHeating(z);
    }
    for (const hw of hotWater) {
      await platform.updateHotWater(hw);
    }
    await h.settle();
  }
  sent.length = 0;
  return { fake, log, sent, platform };
}

/** An accessory as Homebridge restores it from its cache, state and all. */
function cachedAccessory(uuid, kind) {
  return {
    UUID: uuid,
    displayName: uuid,
    context: { hiveId: uuid, kind },
    clusters: kind === 'heating'
      ? { thermostat: { occupiedHeatingSetpoint: 2000, systemMode: SystemMode.Auto } }
      : { onOff: { onOff: false } },
  };
}

// ---- Echo suppression -------------------------------------------------------

test('a setpoint changed and changed back within one poll reaches Hive both times', async () => {
  const { fake, sent } = await setup();

  await fake.controllerWrite(HEATING, { occupiedHeatingSetpoint: 2100 });
  await fake.controllerWrite(HEATING, { occupiedHeatingSetpoint: 2000 });

  assert.deepEqual(sent, [
    ['setHeatingTarget', 'zone-1', 21, 'SCHEDULE'],
    ['setHeatingTarget', 'zone-1', 20, 'SCHEDULE'],
  ]);
});

test('a mode changed and changed back within one poll reaches Hive both times', async () => {
  const { fake, sent } = await setup();

  await fake.controllerWrite(HEATING, { systemMode: SystemMode.Heat });
  await fake.controllerWrite(HEATING, { systemMode: SystemMode.Auto });

  assert.deepEqual(sent, [
    ['setHeatingMode', 'zone-1', 'MANUAL'],
    ['setHeatingMode', 'zone-1', 'SCHEDULE'],
  ]);
});

test('values a poll pushes are not sent back to Hive as commands', async () => {
  const { fake, platform, sent } = await setup();

  // The Hive schedule moves the target, then someone switches to manual in
  // the Hive app: both arrive by poll, and neither is a Matter request.
  await platform.updateHeating(h.zone({ targetTemperature: 18 }));
  await h.settle();
  await platform.updateHeating(h.zone({ targetTemperature: 18, mode: 'MANUAL' }));
  await h.settle();

  assert.deepEqual(sent, []);
  assert.equal(fake.state(HEATING).occupiedHeatingSetpoint, 1800);
  assert.equal(fake.state(HEATING).systemMode, SystemMode.Heat);
});

test('a poll arriving after a controller change is still recognised as an echo', async () => {
  const { fake, platform, sent } = await setup();

  await fake.controllerWrite(HEATING, { occupiedHeatingSetpoint: 2200 });
  // Hive took the command; the confirming poll writes 22 (a no-op) and then a
  // schedule change moves it on to 19.
  await platform.updateHeating(h.zone({ targetTemperature: 22 }));
  await h.settle();
  await platform.updateHeating(h.zone({ targetTemperature: 19 }));
  await h.settle();

  assert.deepEqual(sent, [['setHeatingTarget', 'zone-1', 22, 'SCHEDULE']]);
  assert.equal(fake.state(HEATING).occupiedHeatingSetpoint, 1900);
});

test('a cooling write is absorbed and both setpoints restored, without touching Hive', async () => {
  const { fake, sent } = await setup();

  // matter.js reconciles the pair inside the controller's transaction, so the
  // cooling write drags the heating setpoint down with it.
  await fake.controllerWrite(HEATING, {
    occupiedCoolingSetpoint: 1800,
    occupiedHeatingSetpoint: 1800,
  });
  await h.settle();

  assert.deepEqual(sent, []);
  assert.equal(fake.state(HEATING).occupiedCoolingSetpoint, 3200);
  assert.equal(fake.state(HEATING).occupiedHeatingSetpoint, 2000);
});

// ---- SetpointRaiseLower -----------------------------------------------------

test('SetpointRaiseLower for both setpoints sends the heating change once', async () => {
  const { fake, sent } = await setup();
  const { setpointRaiseLower } = fake.endpoints.get(HEATING).handlers.thermostat;

  await setpointRaiseLower({ mode: 2, amount: 15 });

  assert.deepEqual(sent, [['setHeatingTarget', 'zone-1', 21.5, 'SCHEDULE']]);
});

test('SetpointRaiseLower clamps to the Hive range', async () => {
  const { fake, sent } = await setup();
  const { setpointRaiseLower } = fake.endpoints.get(HEATING).handlers.thermostat;

  await setpointRaiseLower({ mode: 2, amount: 200 });
  await setpointRaiseLower({ mode: 2, amount: -200 });

  assert.deepEqual(sent.map((c) => c[2]), [32, 5]);
});

test('SetpointRaiseLower for heating leaves the send to the setpoint change it causes', async () => {
  const { fake, sent } = await setup();
  const { setpointRaiseLower } = fake.endpoints.get(HEATING).handlers.thermostat;

  await setpointRaiseLower({ mode: 0, amount: 10 });
  assert.deepEqual(sent, []);

  // ...which matter.js then makes, once the handler has returned.
  await fake.controllerWrite(HEATING, { occupiedHeatingSetpoint: 2100 });
  assert.deepEqual(sent, [['setHeatingTarget', 'zone-1', 21, 'SCHEDULE']]);
});

test('SetpointRaiseLower for cooling sends nothing', async () => {
  const { fake, sent } = await setup();
  const { setpointRaiseLower } = fake.endpoints.get(HEATING).handlers.thermostat;

  await setpointRaiseLower({ mode: 1, amount: 10 });

  assert.deepEqual(sent, []);
});

// ---- Hot water --------------------------------------------------------------

test('cancelling a boost returns hot water to its resting mode', async () => {
  const { fake, platform, sent } = await setup();
  await platform.updateHotWater(h.hotWater({ boosting: true, mode: 'MANUAL' }));
  await h.settle();

  const { toggle } = fake.endpoints.get(HOT_WATER).handlers.onOff;
  await toggle();

  assert.deepEqual(sent, [['cancelHotWaterBoost', 'hw-1', 'MANUAL']]);
});

// ---- Reachability -----------------------------------------------------------

test('reachability follows Hive, and an outage marks everything unreachable', async () => {
  const { fake, platform } = await setup();
  const reachable = (uuid) => fake.state(uuid, 'bridgedDeviceBasicInformation').reachable;

  await platform.updateHeating(h.zone({ online: false }));
  await h.settle();
  assert.equal(reachable(HEATING), false);
  assert.equal(reachable(HOT_WATER), true);

  await platform.updateHeating(h.zone());
  await h.settle();
  assert.equal(reachable(HEATING), true);

  await platform.markUnreachable();
  await h.settle();
  assert.equal(reachable(HEATING), false);
  assert.equal(reachable(HOT_WATER), false);

  await platform.updateHotWater(h.hotWater());
  await h.settle();
  assert.equal(reachable(HOT_WATER), true);
});

// ---- Registration -----------------------------------------------------------

for (const regime of ['2.3', '2.4']) {
  test(`endpoints Homebridge ${regime} restored are left for it to adopt; only products that left are unregistered`, async () => {
    const gone = 'hive-matter-heating-gone';
    const { fake } = await setup({
      regime,
      cached: [
        cachedAccessory(HEATING, 'heating'),
        cachedAccessory(HOT_WATER, 'hotwater'),
        cachedAccessory(gone, 'heating'),
      ],
    });

    assert.deepEqual(fake.calls.unregistered, [gone]);
    assert.deepEqual(fake.calls.conflicts, []);
    assert.ok(fake.endpoints.get(HOT_WATER).handlers, 'adopted with the plugin handlers');
  });
}

test('cached accessories Homebridge did not restore are cleared before registering', async () => {
  const { fake } = await setup({
    regime: '2.2',
    cached: [cachedAccessory(HEATING, 'heating'), cachedAccessory(HOT_WATER, 'hotwater')],
    restored: [],
  });

  assert.deepEqual(fake.calls.unregistered, [HEATING, HOT_WATER]);
  assert.deepEqual(fake.calls.conflicts, []);
  assert.ok(fake.endpoints.has(HEATING));
  assert.ok(fake.endpoints.has(HOT_WATER));
});

test('a thermostat that does not come online is retried with the other Presets choice, alone', async () => {
  // A Homebridge that needs Presets while composing the cluster itself: the
  // derivation picks no Presets, and the retry has to recover.
  const { fake, log } = await setup({
    regime: '2.4',
    rejects: (accessory) =>
      accessory.UUID === HEATING && !accessory.clusters.thermostat.presetTypes,
  });

  assert.deepEqual(fake.calls.registered, [HEATING, HOT_WATER, HEATING]);
  assert.deepEqual(fake.calls.unregistered, [HEATING]);
  assert.ok(fake.endpoints.has(HEATING));
  assert.ok(log.messages('info').some((m) => m.includes('online with Presets=true')));
});
