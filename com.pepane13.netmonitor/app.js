'use strict';

const Homey = require('homey');
const { DecoHub } = require('./lib/decohub');

module.exports = class NetworkMonitorApp extends Homey.App {
  async onInit() {
    this.decoHubs = new Map(); // host -> DecoHub (one owner session per mesh)
    this.log('Deco & Internet Monitor started');
  }

  async onUninit() {
    for (const hub of this.decoHubs.values()) hub.stop();
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
