'use strict';

// Minimal Homey SDK 3 mock for the device tests (timers are not run: tests drive polling explicitly).
const en = require('../com.pepane13.netmonitor/locales/en.json');

const trig = [];
const homey = {
  trig,
  __: (k) => k.split('.').reduce((o, x) => o && o[x], en) ?? k,
  clock: { getTimezone: () => 'Europe/Paris' },
  setTimeout: (f, ms) => ({ f, ms }),
  clearTimeout() {},
  setInterval: (f, ms) => ({ f, ms }),
  clearInterval() {},
  flow: {
    getDeviceTriggerCard: (id) => ({ trigger: async (dev, tokens) => trig.push({ id, device: dev.getName(), tokens }) }),
    getConditionCard: () => ({ registerRunListener() {} }),
    getActionCard: () => ({ registerRunListener() {} }),
  },
  manifest: { version: 'test' },
  version: '12.4.0',
  app: null,
  notes: [],
  notifications: { createNotification: async ({ excerpt }) => { homey.notes.push(excerpt); } },
  settings: (() => {
    const store = {};
    const listeners = [];
    return {
      store,
      get: (k) => (k in store ? store[k] : null),
      set: (k, v) => { store[k] = v; listeners.forEach((f) => f(k)); },
      on: (ev, f) => listeners.push(f),
    };
  })(),
  registry: {},
  drivers: { getDriver: (id) => ({ getDevices: () => homey.registry[id] || [] }) },
};

class Device {
  constructor(manifest, deviceSettings, data = { id: 'test' }, name = 'Test device') {
    this.caps = {};
    this.store = {};
    this.settings = { ...deviceSettings };
    this.available = true;
    this.unavailableMessage = null;
    this.driver = { manifest };
    this.homey = homey;
    this._data = data;
    this._name = name;
  }

  getName() { return this._name; }
  getData() { return this._data; }
  hasCapability(c) { return c in this.caps; }
  async addCapability(c) { this.caps[c] = null; }
  async removeCapability(c) { delete this.caps[c]; }
  getCapabilityValue(c) { return this.caps[c] ?? null; }
  async setCapabilityValue(c, v) { if (!(c in this.caps)) throw new Error(`nocap ${c}`); this.caps[c] = v; }
  getStoreValue(k) { return this.store[k]; }
  async setStoreValue(k, v) { this.store[k] = JSON.parse(JSON.stringify(v)); }
  getSetting(k) { return this.settings[k]; }
  getSettings() { return { ...this.settings }; }
  async setSettings(s) { Object.assign(this.settings, s); }
  getAvailable() { return this.available; }
  async setAvailable() { this.available = true; this.unavailableMessage = null; }
  async setUnavailable(m) { this.available = false; this.unavailableMessage = m; }
  log(...a) { if (process.env.VERBOSE) console.log('   [log]', ...a); }
  error(...a) { if (process.env.VERBOSE) console.log('   [err]', ...a); }
}

class App {
  constructor() { this.homey = homey; }
  log(...a) { if (process.env.VERBOSE) console.log('   [app]', ...a); }
  error(...a) { console.log('   [app err]', ...a); }
}

module.exports = { Device, Driver: class {}, App, _trig: trig, _homey: homey };
