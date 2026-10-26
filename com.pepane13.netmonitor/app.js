'use strict';

const Homey = require('homey');
const { DecoHub } = require('./lib/decohub');
const { DiagLog } = require('./lib/diaglog');
const { buildReport } = require('./lib/diagreport');

// App settings (settings page): notification switches and their defaults
const NOTIFY_DEFAULTS = {
  notify_internet: true, // Internet down / back
  notify_quality: false, // threshold alerts (latency, jitter, loss, speed)
  notify_box: true, // box link down / back, reboot, weak fibre signal
  notify_deco: true, // Deco offline / online, weak backhaul
};
const DRIVERS = ['internet', 'livebox', 'deco'];

module.exports = class NetworkMonitorApp extends Homey.App {
  async onInit() {
    this.decoHubs = new Map(); // host -> DecoHub (one owner session per mesh)
    this.diag = new DiagLog(this.homey, { log: (...a) => this.log(...a) });
    this.diag.add('info', 'app', 'app', `${this.homey.__('diag.app_started')} ${this.homey.manifest.version}`);
    this.homey.settings.on('set', (key) => {
      if (key === 'log_level') this.diag.add('info', 'app', 'app', `${this.homey.__('diag.level_changed')} ${this.diag.level}`);
    });
    this.log('Deco & Internet Monitor started');
  }

  async onUninit() {
    for (const hub of this.decoHubs.values()) hub.stop();
    if (this.diag) this.diag.flush();
  }

  /** Adds an entry to the diagnostic log (shared by all devices). */
  logDiag(level, source, category, message) {
    if (this.diag) this.diag.add(level, source, category, message);
  }

  notifyEnabled(key) {
    const v = this.homey.settings.get(key);
    return v === null || v === undefined ? NOTIFY_DEFAULTS[key] !== false : !!v;
  }

  /** Timeline notification, if the matching switch is on in the app settings. */
  async notify(key, message) {
    if (!this.notifyEnabled(key)) return false;
    try {
      await this.homey.notifications.createNotification({ excerpt: message });
      return true;
    } catch (e) {
      this.error('notification failed:', e.message);
      return false;
    }
  }

  _devices() {
    const out = [];
    for (const id of DRIVERS) {
      try {
        out.push(...this.homey.drivers.getDriver(id).getDevices());
      } catch (e) { /* driver not ready */ }
    }
    return out;
  }

  /** Snapshot of every device, for the settings page. */
  getStatus() {
    return this._devices().map((d) => (typeof d.getDiagStatus === 'function' ? d.getDiagStatus() : { name: d.getName() }));
  }

  /** Full diagnostic report (text + JSON), for the settings page. */
  getReport() {
    const appSettings = { log_level: this.homey.settings.get('log_level') };
    Object.keys(NOTIFY_DEFAULTS).forEach((k) => { appSettings[k] = this.homey.settings.get(k); });
    this.diag.add('info', 'app', 'app', this.homey.__('diag.report_exported'));
    return buildReport({
      generated: new Date().toISOString(),
      timeZone: this.homey.clock.getTimezone(),
      appVersion: this.homey.manifest.version,
      homeyVersion: this.homey.version,
      appSettings,
      devices: this._devices().map((d) => (typeof d.getDiagReport === 'function' ? d.getDiagReport() : { driver: '?', name: d.getName() })),
      log: this.diag.get('debug'),
    });
  }

  /** Shared Deco hub for a main Deco address; credentials are updated if they changed. */
  getDecoHub(host, password) {
    let hub = this.decoHubs.get(host);
    if (!hub) {
      hub = new DecoHub({
        host,
        password,
        log: (...a) => this.log('[deco]', ...a),
        setTimeout: (f, ms) => this.homey.setTimeout(f, ms),
        clearTimeout: (t) => this.homey.clearTimeout(t),
      });
      this.decoHubs.set(host, hub);
    } else {
      hub.setCredentials(host, password);
    }
    return hub;
  }

  releaseDecoHub(host, id) {
    const hub = this.decoHubs.get(host);
    if (!hub) return;
    hub.unsubscribe(id);
    if (!hub.subscribers.size) this.decoHubs.delete(host);
  }
};

module.exports.NOTIFY_DEFAULTS = NOTIFY_DEFAULTS;
