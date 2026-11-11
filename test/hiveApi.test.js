const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { HiveApi, TokenExpiredError } = require('../dist/hiveApi');
const h = require('./helpers');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replace fetch with `respond(url, init)`, recording every request. */
function mockFetch(respond) {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
    const { status = 200, body = {} } = respond(String(url), init) ?? {};
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return requests;
}

function api() {
  return new HiveApi(() => 'id-token', h.createLog());
}

function nodes(products, devices = []) {
  return { body: { products, devices } };
}

test('parses a heating zone, resolving online status from its device', async () => {
  mockFetch(() => nodes(
    [{
      id: 'z1',
      type: 'heating',
      parent: 'd1',
      state: { name: 'Downstairs', mode: 'MANUAL', target: 21.5 },
      props: { temperature: 19.2, working: true },
    }],
    [{ id: 'd1', props: { online: false } }],
  ));

  const { zones } = await api().getState();

  assert.deepEqual(zones, [{
    id: 'z1',
    type: 'heating',
    name: 'Downstairs',
    online: false,
    currentTemperature: 19.2,
    targetTemperature: 21.5,
    mode: 'MANUAL',
    boosting: false,
    heating: true,
  }]);
});

test('a boosting heating zone reports the mode it will return to', async () => {
  mockFetch(() => nodes([
    { id: 'z1', type: 'heating', state: { mode: 'BOOST', target: 22 }, props: { previous: { mode: 'SCHEDULE' } } },
    { id: 'z2', type: 'heating', state: { mode: 'BOOST', target: 22 }, props: {} },
  ]));

  const { zones } = await api().getState();

  assert.deepEqual(zones.map((z) => [z.mode, z.boosting]), [['SCHEDULE', true], ['BOOST', true]]);
});

test('hot water is named apart from its zone, and never rests in BOOST', async () => {
  mockFetch(() => nodes([
    { id: 'w1', type: 'hotwater', state: { name: 'Downstairs', mode: 'BOOST' }, props: { previous: { mode: 'MANUAL' } } },
    { id: 'w2', type: 'hotwater', state: { name: 'Hot water', mode: 'BOOST' }, props: {} },
    { id: 'w3', type: 'hotwater', state: { mode: 'OFF' }, props: { working: false } },
  ]));

  const { hotWater } = await api().getState();

  assert.deepEqual(
    hotWater.map((w) => [w.name, w.mode, w.boosting]),
    [
      ['Downstairs Hot Water', 'MANUAL', true],
      ['Hot water', 'SCHEDULE', true],
      ['Hot Water', 'OFF', false],
    ],
  );
});

test('a 401 is reported as an expired token', async () => {
  mockFetch(() => ({ status: 401 }));
  await assert.rejects(api().getState(), TokenExpiredError);
});

test('a new target keeps a scheduled zone on its schedule', async () => {
  const requests = mockFetch(() => ({}));

  await api().setHeatingTarget(h.zone({ mode: 'SCHEDULE' }), 21);
  await api().setHeatingTarget(h.zone({ mode: 'SCHEDULE', boosting: true }), 21);
  await api().setHeatingTarget(h.zone({ mode: 'OFF' }), 21);

  assert.deepEqual(requests.map((r) => JSON.parse(r.body)), [
    { target: 21 },
    { mode: 'MANUAL', target: 21 },
    { mode: 'MANUAL', target: 21 },
  ]);
});

test('a write falls through to the regional host only on a gateway rejection', async () => {
  let requests = mockFetch((url) => (url.includes('beekeeper-uk') ? {} : { status: 403 }));
  await api().setHeatingMode(h.zone({ id: 'z1' }), 'OFF');
  assert.deepEqual(requests.map((r) => new URL(r.url).host), [
    'beekeeper.hivehome.com',
    'beekeeper-uk.hivehome.com',
  ]);

  requests = mockFetch(() => ({ status: 400, body: 'bad   request' }));
  await assert.rejects(api().setHeatingMode(h.zone({ id: 'z1' }), 'OFF'), /HTTP 400 bad request/);
  assert.equal(requests.length, 1);
});

// ---- Radiator valves ------------------------------------------------------
//
// Payload shapes follow pyhiveapi's captured Hive data (src/data/data.json):
// a `trvcontrol` product per room, parented to the hub, listing its `trv`
// devices in props.trvs.

function trvRoom(overrides = {}) {
  return {
    id: 'r1',
    type: 'trvcontrol',
    parent: 'hub1',
    props: { online: true, temperature: 17.6, working: true, trvs: ['v1'], previous: {} },
    state: { name: 'Bedroom', mode: 'SCHEDULE', target: 19 },
    ...overrides,
  };
}

function trv(id, props = {}) {
  return { id, type: 'trv', parent: 'hub1', props: { online: true, power: 'battery', battery: 40, ...props } };
}

test('parses a radiator valve room as a heating zone with a battery level', async () => {
  mockFetch(() => nodes([trvRoom()], [{ id: 'hub1', props: { online: true } }, trv('v1')]));

  const { zones } = await api().getState();

  assert.deepEqual(zones, [{
    id: 'r1',
    type: 'trvcontrol',
    name: 'Bedroom',
    online: true,
    currentTemperature: 17.6,
    targetTemperature: 19,
    mode: 'SCHEDULE',
    boosting: false,
    heating: true,
    battery: 40,
  }]);
});

test('a radiator valve room is online while any of its valves is, never by the hub', async () => {
  const rooms = [
    trvRoom({ id: 'one-down', props: { ...trvRoom().props, trvs: ['up', 'down'] } }),
    trvRoom({ id: 'all-down', props: { ...trvRoom().props, trvs: ['down'] } }),
    trvRoom({ id: 'product-down', props: { ...trvRoom().props, online: false, trvs: ['up'] } }),
  ];
  mockFetch(() => nodes(rooms, [
    // The hub being offline says nothing about the valves.
    { id: 'hub1', props: { online: false } },
    trv('up'),
    trv('down', { online: false }),
  ]));

  const { zones } = await api().getState();

  assert.deepEqual(zones.map((z) => [z.id, z.online]), [
    ['one-down', true],
    ['all-down', false],
    ['product-down', false],
  ]);
});

test('a radiator valve room reports its lowest real battery reading', async () => {
  const rooms = [
    trvRoom({ id: 'two', props: { ...trvRoom().props, trvs: ['a', 'b'] } }),
    trvRoom({ id: 'none', props: { ...trvRoom().props, trvs: ['c', 'missing'] } }),
  ];
  mockFetch(() => nodes(rooms, [
    trv('a', { battery: 60 }),
    trv('b', { battery: 15 }),
    trv('c', { battery: null }),
  ]));

  const { zones } = await api().getState();

  assert.equal(zones[0].battery, 15);
  // A null is no reading, not 0% — and no reading means no battery field.
  assert.ok(!('battery' in zones[1]));
});

test('radiator valve writes go to the trvcontrol node', async () => {
  const requests = mockFetch(() => ({}));
  const room = h.radiatorValve({ id: 'r1', mode: 'MANUAL' });

  await api().setHeatingTarget(room, 21);
  await api().setHeatingMode(room, 'OFF');
  await api().setHeatingMode(h.zone({ id: 'z1' }), 'OFF');

  assert.deepEqual(requests.map((r) => [new URL(r.url).pathname, JSON.parse(r.body)]), [
    ['/1.0/nodes/trvcontrol/r1', { mode: 'MANUAL', target: 21 }],
    ['/1.0/nodes/trvcontrol/r1', { mode: 'OFF' }],
    ['/1.0/nodes/heating/z1', { mode: 'OFF' }],
  ]);
});
