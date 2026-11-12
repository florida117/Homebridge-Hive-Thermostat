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
// How long the plugin gathers a hue/saturation pair (src/matterPlatform.ts).
const COLOUR_GATHER_MS = 100;
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
// A room of radiator valves is a second thermostat, written to its own node.
const valve = (overrides = {}) => zone({
  id: 'room1', type: 'trvcontrol', name: 'Bedroom', battery: 80, ...overrides,
});
// Plugs, lights and sensors, shaped as HiveApi normalises them.
const plug = (overrides = {}) => ({
  id: 'plug1', type: 'activeplug', name: 'Lamp Plug', online: true, on: false, ...overrides,
});
const RANGE = { min: 2700, max: 6535 };
const lights = {
  warm: { id: 'light1', type: 'warmwhitelight', name: 'Hall', online: true, on: false, brightness: 100 },
  tuneable: {
    id: 'light2', type: 'tuneablelight', name: 'Kitchen', online: true, on: false, brightness: 100,
    colourTemperature: 2700, colourTemperatureRange: RANGE,
  },
  colour: {
    id: 'light3', type: 'colourtuneablelight', name: 'Lounge', online: true, on: false, brightness: 100,
    colourTemperature: 3300, colourTemperatureRange: RANGE, colourMode: 'WHITE', hue: 45, saturation: 65,
  },
};
const sensors = {
  motion: { id: 'sensor1', type: 'motionsensor', name: 'Landing', online: true, triggered: false, battery: 80 },
  contact: { id: 'sensor2', type: 'contactsensor', name: 'Back Door', online: true, triggered: false, battery: 80 },
};
const state = {
  zones: [zone(), valve()],
  hotWater: [hotWater()],
  plugs: [plug()],
  lights: Object.values(lights),
  sensors: Object.values(sensors),
};
const HEATING = hap.uuid.generate('hive-matter-heating-zone1');
const VALVE = hap.uuid.generate('hive-matter-heating-room1');
const PLUG = hap.uuid.generate('hive-matter-plug-plug1');
const LIGHT = Object.fromEntries(
  Object.entries(lights).map(([k, l]) => [k, hap.uuid.generate(`hive-matter-light-${l.id}`)]),
);
const SENSOR = Object.fromEntries(
  Object.entries(sensors).map(([k, x]) => [k, hap.uuid.generate(`hive-matter-sensor-${x.id}`)]),
);
const ALL = [HEATING, VALVE, PLUG, ...Object.values(LIGHT), ...Object.values(SENSOR)];
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
    // Commands for anything but a boiler zone are tagged with the node they write.
    setHeatingMode: async (z, mode) => sent.push(`${node(z)}mode ${mode}`),
    setHeatingTarget: async (z, temp) => sent.push(`${node(z)}target ${temp}`),
    setHotWaterBoost: async () => sent.push('boost'),
    cancelHotWaterBoost: async (_id, mode) => sent.push(`cancel to ${mode}`),
    setPlug: async (id, on) => sent.push(`${id} ${on ? 'on' : 'off'}`),
    setLight: async (light, change) => sent.push(`${light.id} ${JSON.stringify(change)}`),
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

  for (const z of state.zones) {
    await platform.updateHeating(z);
  }
  await platform.updateHotWater(state.hotWater[0]);
  await platform.updatePlug(state.plugs[0]);
  for (const l of state.lights) {
    await platform.updateLight(l);
  }
  for (const x of state.sensors) {
    await platform.updateSensor(x);
  }
  await platform.register(state);
  for (let waited = 0; waited < 20_000; waited += 100) {
    if ([...ALL, HOT_WATER].every((uuid) => server.accessories.get(uuid)?.endpoint)) {
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
  for (const thermostat of [endpoint(HEATING), endpoint(VALVE)]) {
    if (thermostat?.state.thermostat.occupancy !== undefined) {
      await thermostat.set({ thermostat: { occupancy: { occupied: true } } });
    }
  }
  return { server, platform, sent, restored, endpoint };
}

const node = (z) => (z.type === 'heating' ? '' : `${z.type} `);

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
  const valveEndpoint = first.endpoint(VALVE);
  check('radiator valve thermostat comes online', !!valveEndpoint);

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

  await first.platform.updateHeating(valve());
  await drain(first);
  await valveEndpoint?.set({ thermostat: { occupiedHeatingSetpoint: 2150 } });
  await valveEndpoint?.set({ thermostat: { systemMode: 0 } });
  sent = await drain(first);
  check('radiator valve commands reach its own node',
    sent.join() === 'trvcontrol target 21.5,trvcontrol mode OFF', JSON.stringify(sent));
  await first.platform.updateHeating(valve({ targetTemperature: 21.5, mode: 'OFF' }));
  sent = await drain(first);
  check('a radiator valve poll write is not echoed to Hive', sent.length === 0, JSON.stringify(sent));

  // ---- Plugs, lights and sensors ---------------------------------------------
  const pushAll = async (overrides = {}) => {
    await first.platform.updatePlug(plug(overrides.plug));
    for (const [k, l] of Object.entries(lights)) {
      await first.platform.updateLight({ ...l, ...overrides[k] });
    }
    for (const [k, x] of Object.entries(sensors)) {
      await first.platform.updateSensor({ ...x, ...overrides[k] });
    }
    return drain(first);
  };
  for (const [name, uuid] of [['plug', PLUG], ...Object.entries(LIGHT), ...Object.entries(SENSOR)]) {
    check(`${name} comes online`, !!first.endpoint(uuid));
  }
  sent = await pushAll();
  check('plug, light and sensor poll writes are not sent back to Hive', sent.length === 0, JSON.stringify(sent));

  const act = (uuid, fn) => first.endpoint(uuid)?.act(fn);
  await act(PLUG, (agent) => agent.onOff.on());
  await act(PLUG, (agent) => agent.onOff.toggle());
  sent = await drain(first);
  check('plug commands reach Hive once each', sent.join() === 'plug1 on,plug1 off', JSON.stringify(sent));

  const options = { transitionTime: 0, optionsMask: {}, optionsOverride: {} };
  await act(LIGHT.warm, (agent) => agent.onOff.on());
  await act(LIGHT.warm, (agent) => agent.levelControl.moveToLevelWithOnOff({ level: 127, ...options }));
  sent = await drain(first);
  check('dimmable light on and level reach Hive',
    sent.join() === 'light1 {"on":true},light1 {"brightness":50}', JSON.stringify(sent));

  await pushAll({ warm: { on: true, brightness: 50 } });
  await act(LIGHT.warm, (agent) => agent.levelControl.moveToLevelWithOnOff({ level: 0, ...options }));
  sent = await drain(first);
  check('level 0 with on/off turns the light off', sent.join() === 'light1 {"on":false}', JSON.stringify(sent));

  await act(LIGHT.tuneable, (agent) => agent.onOff.on());
  await act(LIGHT.tuneable, (agent) =>
    agent.colorControl.moveToColorTemperature({ colorTemperatureMireds: 250, ...options }));
  sent = await drain(first);
  check('tuneable light colour temperature reaches Hive in kelvin',
    sent.join() === 'light2 {"on":true},light2 {"colourTemperature":4000}', JSON.stringify(sent));

  await act(LIGHT.colour, (agent) => agent.onOff.on());
  await pushAll({ warm: { on: true, brightness: 50 }, tuneable: { on: true }, colour: { on: true } });
  await act(LIGHT.colour, (agent) =>
    agent.colorControl.moveToHueAndSaturation({ hue: 127, saturation: 254, ...options }));
  await sleep(COLOUR_GATHER_MS + 100);
  sent = await drain(first);
  check('a colour reaches Hive as one write', sent.join() === 'light3 {"hue":180,"saturation":100}',
    JSON.stringify(sent));

  await act(LIGHT.colour, (agent) =>
    agent.colorControl.moveToColor({ colorX: Math.round(0.64 * 65536), colorY: Math.round(0.33 * 65536), ...options }));
  await sleep(COLOUR_GATHER_MS + 100);
  sent = await drain(first);
  check('an xy colour reaches Hive as one hue/saturation write',
    sent.length === 1 && /^light3 \{"hue":(0|35[89]),"saturation":100\}$/.test(sent[0]), JSON.stringify(sent));

  await act(LIGHT.colour, (agent) =>
    agent.colorControl.moveToColorTemperature({ colorTemperatureMireds: 370, ...options }));
  sent = await drain(first);
  check('colour light colour temperature reaches Hive',
    sent.join() === 'light3 {"colourTemperature":2703}', JSON.stringify(sent));

  sent = await pushAll({
    warm: { on: true, brightness: 50 }, tuneable: { on: true, colourTemperature: 4000 },
    colour: { on: true, colourMode: 'COLOUR', hue: 180, saturation: 100 },
    motion: { triggered: true }, contact: { triggered: true },
  });
  check('a poll after commands is not sent back to Hive', sent.length === 0, JSON.stringify(sent));
  const colourState = first.endpoint(LIGHT.colour)?.state.colorControl;
  check('a polled colour reaches the endpoint',
    colourState?.currentHue === 127 && colourState?.currentSaturation === 254 && colourState?.colorMode === 0,
    JSON.stringify({ hue: colourState?.currentHue, sat: colourState?.currentSaturation, mode: colourState?.colorMode }));
  check('motion reaches the occupancy sensor',
    first.endpoint(SENSOR.motion)?.state.occupancySensing.occupancy.occupied === true);
  check('an open door reaches the contact sensor',
    first.endpoint(SENSOR.contact)?.state.booleanState.stateValue === false);

  await poll({ targetTemperature: 18, online: false });
  check('an offline zone is unreachable', thermostat.state.bridgedDeviceBasicInformation.reachable === false);
  await poll({ targetTemperature: 18 });
  check('a zone back online is reachable', thermostat.state.bridgedDeviceBasicInformation.reachable === true);

  const numbers = new Map([...ALL, HOT_WATER].map((uuid) => [uuid, first.endpoint(uuid)?.number]));
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
  check('every endpoint is live after the restart',
    [...ALL, HOT_WATER].every((uuid) => !!second.endpoint(uuid)),
    [...ALL, HOT_WATER].filter((uuid) => !second.endpoint(uuid)).join(', '));
  for (const [uuid, name] of [
    [HEATING, 'thermostat'], [VALVE, 'radiator valve'], [HOT_WATER, 'hot water'], [PLUG, 'plug'],
    ...Object.entries(LIGHT).map(([k, u]) => [u, `${k} light`]),
    ...Object.entries(SENSOR).map(([k, u]) => [u, `${k} sensor`]),
  ]) {
    check(`the ${name} keeps its endpoint number`, second.endpoint(uuid)?.number === numbers.get(uuid),
      `${numbers.get(uuid)} -> ${second.endpoint(uuid)?.number}`);
  }
  await second.endpoint(HOT_WATER)?.act((agent) => agent.onOff.on());
  sent = await drain(second);
  check('hot water commands work after the restart', sent.join() === 'boost', JSON.stringify(sent));
  await second.endpoint(HOT_WATER)?.act((agent) => agent.onOff.toggle());
  sent = await drain(second);
  check('a hot water toggle reaches Hive once', sent.join() === 'cancel to SCHEDULE', JSON.stringify(sent));
  await second.endpoint(LIGHT.colour)?.act((agent) => agent.onOff.off());
  sent = await drain(second);
  check('light commands work after the restart', sent.join() === 'light3 {"on":false}', JSON.stringify(sent));
  await second.server.stop();
} catch (err) {
  check('run completed', false, err.stack);
} finally {
  rmSync(storagePath, { recursive: true, force: true });
}

check('Homebridge reported no errors', homebridgeErrors.length === 0, homebridgeErrors.join('; '));
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
