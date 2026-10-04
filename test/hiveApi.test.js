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

  await api().setHeatingTarget('z1', 21, h.zone({ mode: 'SCHEDULE' }));
  await api().setHeatingTarget('z1', 21, h.zone({ mode: 'SCHEDULE', boosting: true }));
  await api().setHeatingTarget('z1', 21, h.zone({ mode: 'OFF' }));
  await api().setHeatingTarget('z1', 21);

  assert.deepEqual(requests.map((r) => JSON.parse(r.body)), [
    { target: 21 },
    { mode: 'MANUAL', target: 21 },
    { mode: 'MANUAL', target: 21 },
    { mode: 'MANUAL', target: 21 },
  ]);
});

test('a write falls through to the regional host only on a gateway rejection', async () => {
  let requests = mockFetch((url) => (url.includes('beekeeper-uk') ? {} : { status: 403 }));
  await api().setHeatingMode('z1', 'OFF');
  assert.deepEqual(requests.map((r) => new URL(r.url).host), [
    'beekeeper.hivehome.com',
    'beekeeper-uk.hivehome.com',
  ]);

  requests = mockFetch(() => ({ status: 400, body: 'bad   request' }));
  await assert.rejects(api().setHeatingMode('z1', 'OFF'), /HTTP 400 bad request/);
  assert.equal(requests.length, 1);
});
