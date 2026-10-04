// Run the compiled plugin's Matter layer against the installed Homebridge's
// real Matter server — real matter.js endpoints, real handlers — across a
// restart that restores Homebridge's cache. It checks what the unit tests'
// model of Homebridge cannot: conformance, what matter.js's own command
// implementations hand back to the plugin, and how registration meets
// Homebridge's cache restore.
//
//   npm run build && node scripts/verify-matter.mjs
//
// Against another Homebridge release, install it somewhere else and point
// HOMEBRIDGE_MODULES at the node_modules directory holding it — CI does this
// for every supported release:
//
//   npm install --prefix /tmp/hb --no-save --ignore-scripts homebridge@2.2.1
//   HOMEBRIDGE_MODULES=/tmp/hb/node_modules node scripts/verify-matter.mjs
//
// Not part of `npm test`: it reaches into Homebridge's internal modules (its
// `exports` map does not offer them), which are free to change between
// releases. The node is never started, so nothing is advertised on the
// network.

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = path.resolve(process.env.HOMEBRIDGE_MODULES ?? path.join(REPO, 'node_modules'));
const require = createRequire(path.join(MODULES, 'noop.js'));
const internal = (file) => import(pathToFileURL(path.join(MODULES, file)).href);

const { MatterServer } = await internal('homebridge/dist/matter/server.js');
const { MatterAPIImpl } = await internal('homebridge/dist/matter/MatterAPIImpl.js');
const { Logger: MatterLogger, LogLevel } = await internal('@matter/main/dist/esm/index.js');
const hap = require('@homebridge/hap-nodejs');
const { HiveMatterPlatform } = createRequire(import.meta.url)(path.join(REPO, 'dist/matterPlatform.js'));
// Read from disk: Homebridge's `exports` map does not offer its package.json.
const { version: homebridgeVersion } = JSON.parse(
  readFileSync(path.join(MODULES, 'homebridge/package.json'), 'utf8'),
);
console.log(`Homebridge ${homebridgeVersion}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) {
    failures++;
  }
}

// Homebridge only accepts a storage path under a few roots, the cwd among them.
process.chdir(REPO);
const storagePath = path.join(REPO, '.verify-matter');
rmSync(storagePath, { recursive: true, force: true });
mkdirSync(storagePath);

const zone = (overrides = {}) => ({
  id: 'zone1', type: 'heating', name: 'Downstairs', online: true, currentTemperature: 19,
  targetTemperature: 20, mode: 'SCHEDULE', boosting: false, heating: false, ...overrides,
});
const hotWater = (overrides = {}) => ({
  id: 'hw1', type: 'hotwater', name: 'Hot Water', online: true, mode: 'SCHEDULE',
  on: false, boosting: false, ...overrides,
});
const state = { zones: [zone()], hotWater: [hotWater()] };
const HEATING = hap.uuid.generate('hive-matter-heating-zone1');
const HOT_WATER = hap.uuid.generate('hive-matter-hotwater-hw1');

const homebridgeErrors = [];
const api = new MatterAPIImpl({ hap: { uuid: hap.uuid } });

/** The plugin-facing MatterAPI: like Homebridge's, register/unregister/update return before acting. */
function matterApi(server) {
  const settle = (what, promise) => promise.catch((e) => homebridgeErrors.push(`${what}: ${e.message}`));
  return {
    deviceTypes: api.deviceTypes,
    deviceRequirements: api.deviceRequirements,
    clusterNames: api.clusterNames,
    types: api.types,
    uuid: api.uuid,
    async registerPlatformAccessories(plugin, platform, accessories) {
      for (const accessory of accessories) {
        accessory._associatedPlugin = plugin;
        accessory._associatedPlatform = platform;
      }
      settle('register', server.registerPlatformAccessories(plugin, platform, accessories));
    },
    async unregisterPlatformAccessories(plugin, platform, accessories) {
      settle('unregister', server.unregisterPlatformAccessories(plugin, platform, accessories));
    },
    async updateAccessoryState(uuid, cluster, attributes) {
      settle(`update ${cluster}`, server.updateAccessoryState(uuid, cluster, attributes));
    },
    async getAccessoryState(uuid, cluster) {
      return server.getAccessoryState(uuid, cluster);
    },
  };
}

async function boot() {
  const server = new MatterServer({
    uniqueId: 'verify-hive-matter',
    port: 5599,
    storagePath,
    deferOnline: true,
  });
  // Keep the node offline. `deferOnline` does this from 2.3, but 2.2 has no
  // such option, so the step that would take it online is skipped outright.
  server.serverLifecycle.startServerNode = async () => {};
  MatterLogger.level = LogLevel.FATAL;
  await server.start();
  MatterLogger.level = LogLevel.FATAL;

  const sent = [];
  const commands = {
    setHeatingMode: async (_id, mode) => sent.push(`mode ${mode}`),
    setHeatingTarget: async (_id, temp) => sent.push(`target ${temp}`),
    setHotWaterBoost: async () => sent.push('boost'),
    cancelHotWaterBoost: async (_id, mode) => sent.push(`cancel to ${mode}`),
    pollSoon: () => {},
  };
  const log = {
    info: (message) => message.includes('Matter thermostat') && console.log(`  ${message}`),
    debug() {},
    warn: (message) => console.log(`  WARN ${message}`),
    error: (message) => console.log(`  ERROR ${message}`),
  };
  const platform = new HiveMatterPlatform(
    { isMatterEnabled: () => true, matter: matterApi(server) },
    log,
    commands,
    30,
  );
  for (const cached of server.getAllCachedAccessories()) {
    platform.configureAccessory({ UUID: cached.uuid, displayName: cached.displayName, context: cached.context });
  }
  const restored = new Map([...server.accessories].map(([uuid, a]) => [uuid, a.endpoint]));

  await platform.updateHeating(state.zones[0]);
  await platform.updateHotWater(state.hotWater[0]);
  await platform.register(state);
  for (let waited = 0; waited < 20_000; waited += 100) {
    if ([HEATING, HOT_WATER].every((uuid) => server.accessories.get(uuid)?.endpoint)) {
      break;
    }
    await sleep(100);
  }
  await sleep(500);
  const endpoint = (uuid) => server.accessories.get(uuid)?.endpoint;
  // Where the Occupancy feature is live (<= 2.2.x), matter.js marks the
  // thermostat occupied when the node goes online, which this node never does.
  // Until then setpoint commands move the *unoccupied* setpoints, so do what
  // going online would.
  const thermostat = endpoint(HEATING);
  if (thermostat?.state.thermostat.occupancy !== undefined) {
    await thermostat.set({ thermostat: { occupancy: { occupied: true } } });
  }
  return { server, platform, sent, restored, endpoint };
}

/** Settle, then return (and clear) what reached "Hive". */
async function drain(run) {
  await sleep(300);
  return run.sent.splice(0);
}

try {
  // ---- First start ----------------------------------------------------------
  const first = await boot();
  const thermostat = first.endpoint(HEATING);
  check('thermostat comes online', !!thermostat);
  check('hot water comes online', !!first.endpoint(HOT_WATER));

  const raise = (mode, amount) =>
    thermostat.act((agent) => agent.thermostat.setpointRaiseLower({ mode, amount }));
  const poll = async (overrides) => {
    await first.platform.updateHeating(zone(overrides));
    await drain(first);
  };

  await poll({});
  await raise(0, 10);
  let sent = await drain(first);
  const after = thermostat.state.thermostat;
  check('SetpointRaiseLower(Heat) reaches Hive once', sent.length === 1 && sent[0] === 'target 21',
    `${JSON.stringify(sent)}; occupied ${after.occupiedHeatingSetpoint}, unoccupied ` +
    `${after.unoccupiedHeatingSetpoint}, occupancy ${JSON.stringify(after.occupancy)}`);

  await poll({ targetTemperature: 21 });
  await raise(2, 10);
  sent = await drain(first);
  check('SetpointRaiseLower(Both) reaches Hive once', sent.length === 1 && sent[0] === 'target 22', JSON.stringify(sent));

  await poll({ targetTemperature: 22 });
  await raise(2, -10);
  sent = await drain(first);
  check('SetpointRaiseLower(Both, down) reaches Hive once', sent.length === 1 && sent[0] === 'target 21', JSON.stringify(sent));

  await poll({ targetTemperature: 21 });
  await poll({ targetTemperature: 21 });
  await thermostat.set({ thermostat: { occupiedHeatingSetpoint: 2200 } });
  await thermostat.set({ thermostat: { occupiedHeatingSetpoint: 2100 } });
  sent = await drain(first);
  check('a setpoint changed and back reaches Hive both times', sent.join() === 'target 22,target 21', JSON.stringify(sent));

  await poll({ targetTemperature: 18 });
  sent = await drain(first);
  check('a poll write is not echoed to Hive', sent.length === 0, JSON.stringify(sent));

  await thermostat.set({ thermostat: { occupiedCoolingSetpoint: 1700 } });
  sent = await drain(first);
  const t = thermostat.state.thermostat;
  check(
    'a cooling write is absorbed and repaired',
    sent.length === 0 && t.occupiedCoolingSetpoint === 3200 && t.occupiedHeatingSetpoint === 1800,
    `sent ${JSON.stringify(sent)}, heating ${t.occupiedHeatingSetpoint}, cooling ${t.occupiedCoolingSetpoint}`,
  );

  await poll({ targetTemperature: 18, online: false });
  check('an offline zone is unreachable', thermostat.state.bridgedDeviceBasicInformation.reachable === false);
  await poll({ targetTemperature: 18 });
  check('a zone back online is reachable', thermostat.state.bridgedDeviceBasicInformation.reachable === true);

  const numbers = new Map([HEATING, HOT_WATER].map((uuid) => [uuid, first.endpoint(uuid)?.number]));
  await sleep(2500); // let Homebridge persist its accessory cache
  await first.server.stop();

  // ---- Restart from cache ---------------------------------------------------
  const second = await boot();
  // Homebridge 2.3 and later restore cached endpoints; 2.2 restores none.
  if (second.restored.size > 0) {
    check(
      'the restored hot water endpoint is adopted, not rebuilt',
      second.restored.get(HOT_WATER) !== undefined &&
        second.restored.get(HOT_WATER) === second.endpoint(HOT_WATER),
    );
  } else {
    console.log('  (this Homebridge restores nothing from its cache)');
  }
  check('both endpoints are live after the restart',
    !!second.endpoint(HEATING) && !!second.endpoint(HOT_WATER));
  for (const [uuid, name] of [[HEATING, 'thermostat'], [HOT_WATER, 'hot water']]) {
    check(`the ${name} keeps its endpoint number`, second.endpoint(uuid)?.number === numbers.get(uuid),
      `${numbers.get(uuid)} -> ${second.endpoint(uuid)?.number}`);
  }
  await second.endpoint(HOT_WATER)?.act((agent) => agent.onOff.on());
  sent = await drain(second);
  check('hot water commands work after the restart', sent.join() === 'boost', JSON.stringify(sent));
  await second.server.stop();
} catch (err) {
  check('run completed', false, err.stack);
} finally {
  rmSync(storagePath, { recursive: true, force: true });
}

check('Homebridge reported no errors', homebridgeErrors.length === 0, homebridgeErrors.join('; '));
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
