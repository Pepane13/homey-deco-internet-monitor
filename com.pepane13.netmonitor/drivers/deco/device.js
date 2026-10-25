'use strict';

const Homey = require('homey');

const MASTER_CAPS = ['netmon_online.internet', 'netmon_clients.total', 'netmon_clients.band24', 'netmon_clients.band5', 'netmon_clients.wired', 'netmon_load.cpu', 'netmon_load.mem'];
const WIRELESS_CAPS = ['netmon_signal.band5', 'netmon_signal.band24', 'netmon_speed'];

module.exports = class DecoDevice extends Homey.Device {
  async onInit() {
    this.failures = 0;
    this.knownClients = null; // Set of MACs on this node, null until the first snapshot
    this.weakCount = 0;
    this.okCount = 0;
    this.state = this.getStoreValue('state') || { online: null, offlineSince: null, weak: false };
    // Devices paired before the traffic indicators existed
    this.samples = []; // traffic samples for the average indicator
    for (const c of ['netmon_rate', 'netmon_throughput.down', 'netmon_throughput.up']) {
      if (!this.hasCapability(c)) await this.addCapability(c).catch((e) => this.error('addCapability', c, e.message));
    }
    this._subscribe();
    this.log('Deco device ready', this.getData().id);
  }

  get mac() {
    return this.getData().id;
  }

  _subscribe() {
    this.host = this.getSetting('host');
    this.hub = this.homey.app.getDecoHub(this.host, this.getSetting('password'));
    this.hub.subscribe(this.mac, {
      interval: Number(this.getSetting('poll_interval')) || 60,
      onSnapshot: (snap) => this.onSnapshot(snap).catch((e) => this.error('snapshot', e.message)),
      onError: (err) => this.onPollError(err).catch((e) => this.error('poll error', e.message)),
    });
  }

  _unsubscribe() {
    if (this.host) this.homey.app.releaseDecoHub(this.host, this.mac);
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.some((k) => ['host', 'password', 'poll_interval'].includes(k))) {
      this.homey.setTimeout(() => {
        this._unsubscribe();
        this._subscribe();
      }, 100);
    }
  }

  onDeleted() { this._unsubscribe(); }

  onUninit() { this._unsubscribe(); }

  async _set(cap, value) {
    if (!this.hasCapability(cap) || this.getCapabilityValue(cap) === value) return;
    await this.setCapabilityValue(cap, value).catch((e) => this.error('set', cap, e.message));
  }

  async _caps(wanted, present) {
    for (const c of wanted) if (present && !this.hasCapability(c)) await this.addCapability(c).catch((e) => this.error('addCapability', c, e.message));
    for (const c of wanted) if (!present && this.hasCapability(c)) await this.removeCapability(c).catch((e) => this.error('removeCapability', c, e.message));
  }

  _trigger(id, tokens = {}) {
    return this.homey.flow.getDeviceTriggerCard(id).trigger(this, tokens).catch((e) => this.error('trigger', id, e.message));
  }

  async onPollError(err) {
    this.failures++;
    if (err.code === 'EAUTH') {
      await this.setUnavailable(this.homey.__('status.deco_owner'));
    } else if (err.code === 'EUNSUPPORTED') {
      await this.setUnavailable(this.homey.__('status.unsupported'));
    } else if (this.failures >= 3) {
      await this.setUnavailable(`${this.homey.__('status.unreachable')} (${err.message})`);
    }
  }

  _bandLabel(band) {
    if (!band) return '';
    return String(band).split('+').map((b) => {
      const k = `band.${b}`;
      const txt = this.homey.__(k);
      return txt === k ? b : txt;
    }).join(' + ');
  }

  async onSnapshot(snap) {
    this.failures = 0;
    if (!this.getAvailable()) await this.setAvailable().catch(() => {});
    const node = snap.decos.find((d) => d.mac === this.mac);
    const now = snap.ts;
    const online = !!(node && node.online);

    // Online / offline transitions
    if (this.state.online != null && this.state.online !== online) {
      if (!online) {
        this.state.offlineSince = now;
        this.log('Deco offline');
        await this._trigger('node_offline');
      } else {
        const duration = this.state.offlineSince ? Math.round((now - this.state.offlineSince) / 1000) : 0;
        this.state.offlineSince = null;
        this.log(`Deco back online after ${duration} s`);
        await this._trigger('node_online', { duration });
      }
    }
    this.state.online = online;
    await this._set('netmon_online', online);

    if (node) {
      await this._updateInfo(node);
      await this._caps(MASTER_CAPS, node.master);
      const wireless = !node.master && node.backhaul && node.backhaul !== 'wired' && !/wired/.test(node.backhaul);
      await this._caps(WIRELESS_CAPS, !!wireless);

      // Backhaul description
      let text;
      if (node.master) text = this.homey.__('deco.main');
      else if (!wireless) text = this._bandLabel(node.backhaul || 'wired');
      else text = `${this._bandLabel(node.backhaul)}${node.backhaulSpeed ? ` · ${node.backhaulSpeed} Mbit/s` : ''}`;
      await this._set('netmon_text', text);

      if (node.master) {
        await this._updateDiag(snap.diag);
        await this._set('netmon_online.internet', node.internet !== false);
        const all = Object.values(snap.clientsByDeco).filter(Array.isArray).flat().filter((c) => c.online);
        await this._set('netmon_clients.total', all.length);
        await this._set('netmon_clients.band24', all.filter((c) => c.band === 'band2_4').length);
        await this._set('netmon_clients.band5', all.filter((c) => c.band === 'band5').length);
        await this._set('netmon_clients.wired', all.filter((c) => c.band === 'wired').length);
        await this._set('netmon_load.cpu', snap.perf.cpu);
        await this._set('netmon_load.mem', snap.perf.mem);
      }

      if (wireless) {
        await this._set('netmon_signal.band5', node.signal5);
        await this._set('netmon_signal.band24', node.signal24);
        await this._set('netmon_speed', node.backhaulSpeed);
        await this._checkBackhaul(node);
      }
    }

    await this._diffClients(snap.clientsByDeco[this.mac]);
    await this.setStoreValue('state', this.state);
  }

  /** Rolling mean of the node traffic over the configured window, shown as "↓ 12.3  ↑ 2.1 Mbit/s". */
  async _updateAverage(down, up, ts) {
    const windowMs = (Number(this.getSetting('avg_window')) || 15) * 60000;
    this.samples.push({ ts, down, up });
    while (this.samples.length && this.samples[0].ts < ts - windowMs) this.samples.shift();
    const n = this.samples.length;
    const avgDown = this.samples.reduce((a, x) => a + x.down, 0) / n;
    const avgUp = this.samples.reduce((a, x) => a + x.up, 0) / n;
    await this._set('netmon_rate', `↓ ${this._fmt(avgDown)}  ↑ ${this._fmt(avgUp)} Mbit/s`);
  }

  _fmt(v) {
    const lang = (this.homey.i18n && this.homey.i18n.getLanguage && this.homey.i18n.getLanguage()) || 'en';
    const digits = v < 10 ? 1 : 0;
    return v.toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  /** Traffic diagnostic on the main Deco: what the firmware actually returns for the client rates. */
  async _updateDiag(d) {
    if (!d) return;
    const text = `${d.perNodeWithTraffic}/${d.clients} (module) · ${d.globalWithTraffic}/${d.globalClients} (global) · fields: ${d.fields.join(', ')}`;
    if (this.getSetting('diag_rates') !== text) await this.setSettings({ diag_rates: text }).catch((e) => this.error('setSettings', e.message));
  }

  /** Per-node information shown in the device settings (IP, role, MAC, model, firmware). */
  async _updateInfo(node) {
    const info = {
      node_ip: node.ip || '',
      node_role: this.homey.__(node.master ? 'deco.role_main' : 'deco.role_satellite'),
      node_mac: node.mac || '',
      node_model: node.model || '',
      node_firmware: node.firmware || '',
    };
    if (Object.keys(info).some((k) => this.getSetting(k) !== info[k])) {
      await this.setSettings(info).catch((e) => this.error('setSettings', e.message));
    }
  }

  async _checkBackhaul(node) {
    const signal = /band5/.test(node.backhaul) ? node.signal5 : node.signal24;
    const speed = node.backhaulSpeed;
    const minSignal = Number(this.getSetting('min_signal'));
    const minSpeed = Number(this.getSetting('min_speed')) || 0;
    const weak = (signal != null && Number.isFinite(minSignal) && signal < minSignal) || (minSpeed > 0 && speed != null && speed < minSpeed);
    if (weak) { this.weakCount++; this.okCount = 0; } else { this.okCount++; this.weakCount = 0; }
    if (!this.state.weak && this.weakCount >= 2) {
      this.state.weak = true;
      this.log(`Backhaul weak: signal ${signal}, ${speed} Mbit/s`);
      await this._trigger('backhaul_weak', { signal: signal ?? -1, speed: speed ?? 0 });
    } else if (this.state.weak && this.okCount >= 2) {
      this.state.weak = false;
      await this._trigger('backhaul_ok', { signal: signal ?? -1, speed: speed ?? 0 });
    }
  }

  async _diffClients(list) {
    if (!Array.isArray(list)) return; // this node's client list could not be read: keep the previous state
    const current = new Map(list.filter((c) => c.online).map((c) => [c.mac, c]));
    await this._set('netmon_clients', current.size);
    // Traffic of the clients attached to this node (kbit/s -> Mbit/s)
    let down = 0;
    let up = 0;
    for (const c of current.values()) { down += c.down || 0; up += c.up || 0; }
    await this._set('netmon_throughput.down', Math.round(down / 100) / 10);
    await this._set('netmon_throughput.up', Math.round(up / 100) / 10);
    await this._updateAverage(down / 1000, up / 1000, Date.now());
    const prev = this.knownClients;
    this.knownClients = current;
    if (!prev) return; // first snapshot: no events
    for (const [mac, c] of current) {
      if (!prev.has(mac)) {
        await this._trigger('client_connected', { name: c.name || mac, mac, ip: c.ip || '', band: this._bandLabel(c.band), network: c.network || 'main' });
      }
    }
    for (const [mac, c] of prev) {
      if (!current.has(mac)) await this._trigger('client_disconnected', { name: c.name || mac, mac });
    }
  }

  isOnline() {
    return this.getCapabilityValue('netmon_online') === true;
  }

  /** Searches the whole mesh (every node) for a connected client matching name, IP or MAC. */
  isClientConnected(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q || !this.hub.last) return false;
    const all = Object.values(this.hub.last.clientsByDeco).filter(Array.isArray).flat().filter((c) => c.online);
    const qMac = q.replace(/-/g, ':');
    return all.some((c) => (c.name || '').toLowerCase().includes(q) || c.ip === q || c.mac.toLowerCase() === qMac);
  }
};
