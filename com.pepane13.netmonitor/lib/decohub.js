'use strict';

const { DecoClient } = require('./deco');

/*
 * One shared session and one polling loop per main Deco, whatever the number of Deco devices in
 * Homey: the Deco accepts a single owner session, so every node device subscribes to this hub.
 */
class DecoHub {
  constructor({ host, password, log = () => {}, setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout, clientFactory }) {
    this.host = host;
    this.password = password;
    this.log = log;
    this._st = st;
    this._ct = ct;
    this.client = clientFactory ? clientFactory({ host, password }) : new DecoClient({ host, password });
    this.subscribers = new Map(); // id -> { interval, onSnapshot, onError }
    this.timer = null;
    this.running = false;
    this.last = null;
    this.lastError = null;
  }

  subscribe(id, { interval, onSnapshot, onError }) {
    this.subscribers.set(id, { interval, onSnapshot, onError });
    if (this.last) onSnapshot(this.last);
    this._schedule(500);
  }

  unsubscribe(id) {
    this.subscribers.delete(id);
    if (!this.subscribers.size) this.stop();
  }

  setCredentials(host, password) {
    if (host === this.host && password === this.password) return;
    this.host = host;
    this.password = password;
    this.client.base = /^https?:\/\//.test(host) ? host : `http://${host}`;
    this.client.password = password;
    this.client.stok = null;
    this._schedule(500);
  }

  get interval() {
    let min = Infinity;
    for (const s of this.subscribers.values()) min = Math.min(min, s.interval || 60);
    return Number.isFinite(min) ? Math.max(30, min) : 60;
  }

  _schedule(ms) {
    if (this.timer) this._ct(this.timer);
    this.timer = this._st(() => this.poll().catch(() => {}), ms);
  }

  stop() {
    if (this.timer) this._ct(this.timer);
    this.timer = null;
  }

  /** Reads devices, performance and clients per node, then notifies every subscriber. */
  async poll() {
    if (this.running) return this.last;
    this.running = true;
    const started = Date.now();
    try {
      const decos = await this.client.listDecos();
      let perf = { cpu: null, mem: null };
      try { perf = await this.client.getPerformance(); } catch (e) { this.log('Deco performance unavailable:', e.message); }
      const clientsByDeco = await this.client.listClientsByDeco(decos);
      this.last = { ts: Date.now(), responseMs: Date.now() - started, decos, perf, clientsByDeco, diag: clientsByDeco.diag || null };
      this.lastError = null;
      for (const s of this.subscribers.values()) {
        try { await s.onSnapshot(this.last); } catch (e) { this.log('Deco subscriber error:', e.message); }
      }
      return this.last;
    } catch (err) {
      this.lastError = err;
      for (const s of this.subscribers.values()) {
        try { await s.onError(err); } catch (e) { /* ignore */ }
      }
      throw err;
    } finally {
      this.running = false;
      if (this.subscribers.size) this._schedule(this.interval * 1000);
    }
  }
}

module.exports = { DecoHub };
