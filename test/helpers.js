/**
 * Test doubles for the parts of Homebridge the plugin talks to. The tests run
 * against the compiled plugin in dist/, so `npm test` builds first.
 *
 * HomeKit is real: accessories are HAP-NodeJS objects, so characteristic reads
 * and writes go through the handlers the plugin registers. Matter is a model,
 * but a faithful one where it matters: like Homebridge, it applies a state
 * update on a later tick, and calls the plugin's thermostat handlers only when
 * an attribute actually changes — whoever changed it.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hap = require('@homebridge/hap-nodejs');

/** Let deferred work — Matter updates, promise chains — run to completion. */
async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Wait for `predicate` to hold, failing after `timeoutMs`. */
async function until(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createLog() {
  const lines = [];
  const log = {};
  for (const level of ['info', 'warn', 'error', 'debug', 'success']) {
    log[level] = (message) => lines.push({ level, message });
  }
  log.lines = lines;
  log.messages = (level) => lines.filter((l) => l.level === level).map((l) => l.message);
  return log;
}

function tempStorage() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hive-thermostat-test-'));
}

/** A Homebridge API double around real HAP. */
function createHomebridge({ storagePath = tempStorage(), matter } = {}) {
  const listeners = new Map();

  class PlatformAccessory {
    constructor(displayName, UUID) {
      this.displayName = displayName;
      this.UUID = UUID;
      this.context = {};
      this.accessory = new hap.Accessory(displayName, UUID);
    }

    getService(service) {
      return this.accessory.getService(service);
    }

    addService(service) {
      return this.accessory.addService(service);
    }
  }

  const api = {
    hap,
    platformAccessory: PlatformAccessory,
    user: { storagePath: () => storagePath },
    registered: [],
    unregistered: [],
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    emit(event) {
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
    },
    registerPlatformAccessories(_plugin, _platform, accessories) {
      api.registered.push(...accessories);
    },
    unregisterPlatformAccessories(_plugin, _platform, accessories) {
      api.unregistered.push(...accessories);
    },
    updatePlatformAccessories() {},
    isMatterEnabled: () => matter !== undefined,
    matter,
  };
  return api;
}

const THERMOSTAT_HANDLERS = {
  systemMode: 'systemModeChange',
  occupiedHeatingSetpoint: 'occupiedHeatingSetpointChange',
  occupiedCoolingSetpoint: 'occupiedCoolingSetpointChange',
};

/**
 * A MatterAPI double.
 *
 * `regime` picks which Homebridge generation it imitates, by the same
 * observable properties the plugin detects: '2.4' offers deviceRequirements,
 * '2.2' hands out a pre-composed thermostat, '2.3' a bare one.
 *
 * `rejects(accessory)` makes a registration fail the way a conformance error
 * does in Homebridge: silently, with the endpoint never coming online.
 *
 * An endpoint restored from cache (see `restore()`) is adopted when the
 * plugin registers its UUID, as Homebridge 2.3 and later do. Registering any
 * other UUID that is still present is refused, as Homebridge refuses it
 * ("already registered").
 */
function createMatter({ regime = '2.4', rejects = () => false } = {}) {
  const endpoints = new Map();
  const calls = { registered: [], unregistered: [], conflicts: [] };

  async function apply(uuid, cluster, attributes) {
    const endpoint = endpoints.get(uuid);
    if (!endpoint) {
      throw new Error(`Accessory ${uuid} not found or not registered`);
    }
    const state = (endpoint.state[cluster] ??= {});
    for (const [name, value] of Object.entries(attributes)) {
      if (state[name] === value) {
        continue;
      }
      state[name] = value;
      const handler = cluster === 'thermostat'
        ? endpoint.handlers?.thermostat?.[THERMOSTAT_HANDLERS[name]]
        : undefined;
      if (handler) {
        await handler({ [name]: value });
      }
    }
  }

  const base = { name: 'Thermostat', with: (...behaviors) => ({ name: 'Thermostat', behaviors }) };
  if (regime === '2.2') {
    base.behaviors = { thermostat: {} };
  }

  const matter = {
    types: {
      Thermostat: {
        SystemMode: { Off: 0, Auto: 1, Cool: 3, Heat: 4 },
        ThermostatRunningMode: { Off: 0, Cool: 3, Heat: 4 },
        ControlSequenceOfOperation: { HeatingOnly: 2 },
        SetpointRaiseLowerMode: { Heat: 0, Cool: 1, Both: 2 },
        PresetScenario: { Occupied: 1 },
      },
    },
    deviceTypes: { Thermostat: base, OnOffOutlet: { name: 'OnOffOutlet' } },
    clusterNames: {
      Thermostat: 'thermostat',
      OnOff: 'onOff',
      BridgedDeviceBasicInformation: 'bridgedDeviceBasicInformation',
    },
    uuid: { generate: (name) => name },
    async registerPlatformAccessories(_plugin, _platform, accessories) {
      for (const accessory of accessories) {
        calls.registered.push(accessory.UUID);
        const existing = endpoints.get(accessory.UUID);
        if (existing && !existing.restored) {
          calls.conflicts.push(accessory.UUID);
          continue;
        }
        if (rejects(accessory)) {
          continue;
        }
        endpoints.set(accessory.UUID, {
          accessory,
          handlers: accessory.handlers,
          state: {
            ...structuredClone(accessory.clusters),
            bridgedDeviceBasicInformation: { reachable: true },
          },
        });
      }
    },
    async unregisterPlatformAccessories(_plugin, _platform, accessories) {
      for (const accessory of accessories) {
        calls.unregistered.push(accessory.UUID);
        endpoints.delete(accessory.UUID);
      }
    },
    async getAccessoryState(uuid, cluster) {
      return endpoints.get(uuid)?.state[cluster];
    },
    // Homebridge applies the update on a later tick, after returning.
    async updateAccessoryState(uuid, cluster, attributes) {
      setImmediate(() => {
        apply(uuid, cluster, attributes).catch(() => {
          /* Homebridge logs a failed update; nothing reaches the plugin */
        });
      });
    },
  };
  if (regime === '2.4') {
    matter.deviceRequirements = {
      Thermostat: { ThermostatServer: { with: (...features) => ({ features }) } },
    };
  }

  return {
    matter,
    calls,
    endpoints,
    /** An endpoint restored from Homebridge's cache before the plugin starts. */
    restore(accessory) {
      endpoints.set(accessory.UUID, {
        accessory,
        handlers: undefined,
        restored: true,
        state: structuredClone(accessory.clusters ?? {}),
      });
    },
    /** The current value of a cluster on an endpoint. */
    state: (uuid, cluster = 'thermostat') => endpoints.get(uuid)?.state[cluster],
    /** A controller writing thermostat attributes, as one transaction. */
    controllerWrite: (uuid, attributes) => apply(uuid, 'thermostat', attributes),
  };
}

/** The Hive commands the Matter layer issues, recorded. */
function recordCommands() {
  const sent = [];
  return {
    sent,
    commands: {
      setHeatingMode: async (id, mode) => {
        sent.push(['setHeatingMode', id, mode]);
      },
      setHeatingTarget: async (id, temp, current) => {
        sent.push(['setHeatingTarget', id, temp, current?.mode]);
      },
      setHotWaterBoost: async (id, minutes) => {
        sent.push(['setHotWaterBoost', id, minutes]);
      },
      cancelHotWaterBoost: async (id, returnTo) => {
        sent.push(['cancelHotWaterBoost', id, returnTo]);
      },
      pollSoon: () => {},
    },
  };
}

function zone(overrides = {}) {
  return {
    id: 'zone-1',
    type: 'heating',
    name: 'Downstairs',
    online: true,
    currentTemperature: 19,
    targetTemperature: 20,
    mode: 'SCHEDULE',
    boosting: false,
    heating: false,
    ...overrides,
  };
}

function hotWater(overrides = {}) {
  return {
    id: 'hw-1',
    type: 'hotwater',
    name: 'Hot Water',
    online: true,
    mode: 'SCHEDULE',
    on: false,
    boosting: false,
    ...overrides,
  };
}

module.exports = {
  hap,
  settle,
  until,
  createLog,
  tempStorage,
  createHomebridge,
  createMatter,
  recordCommands,
  zone,
  hotWater,
};
