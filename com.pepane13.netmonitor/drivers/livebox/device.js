'use strict';

const Homey = require('homey');
const { createBoxClient } = require('../../lib/boxes');
const { counterRate } = require('../../lib/monitor');
const { linkQuality, timeOf } = require('../../lib/quality');

const RATE_LIMIT_MIN = 30;

const COUNTER_INTERVAL = 10000; // 32-bit counters wrap every ~34 s at 1 Gbit/s
const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

module.exports = class LiveboxDevice extends Homey.Device {
  async onInit() {
    this.failures = 0;
    this.prev = this.getStoreValue('prev') || {};
    this.lastCounters = null;
    this.counterReads = 0;
    this.rejected = 0;
    this.onceAt = {};
    this.lastError = null;
    this.lastStatus = null;
    this.quality = this.getStoreValue('quality_ema') ?? null;
    this.qualityParts = null;
    this._client();
    for (const c of this.driver.manifest.capabilities) {
      if (!this.hasCapability(c)) await this.addCapability(c).catch((e) => this.error('addCapability', c, e.message));
    }
    if (!this.supportsSpeedtest()) {
      for (const cap of ['netmon_download.box', 'netmon_upload.box', 'netmon_latency.box']) {
        if (this.hasCapability(cap)) await this.removeCapability(cap).catch(() => {});
      }
    }
    this._diag('info', 'app', `${this._t('diag.device_started')} ${this.getSetting('host') || ''}`);
    this._schedule(1000);
    this._scheduleCounters(5000);
    this.log('Livebox device ready');
  }

  get operator() {
    return this.getSetting('operator') || 'orange';
  }

  _client() {
    this.client = createBoxClient(this.operator, {
      host: this.getSetting('host'),
      username: this.getSetting('username') || 'admin',
      password: this.getSetting('password') || '',
    });
    this.lastCounters = null;
  }

  async onSettings({ changedKeys }) {
    this._diag('info', 'app', this._t('diag.settings_changed', { keys: changedKeys.filter((k) => k !== 'password').join(', ') || 'password' }));
    if (changedKeys.some((k) => ['host', 'username', 'password', 'operator'].includes(k))) {
      this.homey.setTimeout(() => { this._client(); this._schedule(500); }, 100);
    } else if (changedKeys.includes('poll_interval')) {
      this._schedule(1000);
    }
  }

  onDeleted() { this.onUninit(); }

  onUninit() {
    if (this.timer) this.homey.clearTimeout(this.timer);
    if (this.counterTimer) this.homey.clearTimeout(this.counterTimer);
    this.timer = null;
    this.counterTimer = null;
  }

  async _set(cap, value) {
    if (!this.hasCapability(cap) || this.getCapabilityValue(cap) === value) return;
    await this.setCapabilityValue(cap, value).catch((e) => this.error('set', cap, e.message));
  }

  /** Translated message with {var} placeholders replaced. */
  _t(key, vars = {}) {
    let s = this.homey.__(key);
    if (typeof s !== 'string') s = key;
    return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
  }

  _diag(level, category, message) {
    const app = this.homey.app;
    if (app && typeof app.logDiag === 'function') app.logDiag(level, this.getName(), category, message);
  }

  _diagOnce(key, minutes, level, category, message) {
    const now = Date.now();
    if (this.onceAt[key] && now - this.onceAt[key] < minutes * 60000) return false;
    this.onceAt[key] = now;
    this._diag(level, category, message);
    return true;
  }

  _notify(key, message) {
    const app = this.homey.app;
    return app && typeof app.notify === 'function' ? app.notify(key, message) : Promise.resolve(false);
  }

  _time(ts) {
    return timeOf(ts, this.homey.clock.getTimezone());
  }

  /**
   * Highest physically possible rate per direction, Mbit/s: the line capacity measured by the last
   * native speed test (+15 %), or 2500 Mbit/s (Livebox 5 WAN) before the first test.
   */
  _maxRate(dir) {
    const st = this.getStoreValue('box_speedtest');
    const v = st && Number(dir === 'down' ? st.download : st.upload);
    return v > 0 ? v * 1.15 : 2500;
  }

  _trigger(id, tokens = {}) {
    return this.homey.flow.getDeviceTriggerCard(id).trigger(this, tokens).catch((e) => this.error('trigger', id, e.message));
  }

  _schedule(ms) {
    if (this.timer) this.homey.clearTimeout(this.timer);
    this.timer = this.homey.setTimeout(async () => {
      await this.poll().catch(() => {});
      this._schedule((Number(this.getSetting('poll_interval')) || 60) * 1000);
    }, ms);
  }

  _scheduleCounters(ms) {
    if (this.counterTimer) this.homey.clearTimeout(this.counterTimer);
    this.counterTimer = this.homey.setTimeout(async () => {
      await this.pollCounters().catch((e) => this.log('counters:', e.message));
      this._scheduleCounters(COUNTER_INTERVAL);
    }, ms);
  }

  async pollCounters() {
    if (this.countersUnsupported) return;
    const c = await this.client.readCounters();
    if (!c || c.rx == null) {
      // SFR boxes do not expose traffic counters
      this.countersUnsupported = true;
      for (const cap of ['netmon_throughput.down', 'netmon_throughput.up']) {
        if (this.hasCapability(cap)) await this.removeCapability(cap).catch(() => {});
      }
      return;
    }
    const ts = Date.now();
    const last = this.lastCounters;
    this.lastCounters = { rx: c.rx, tx: c.tx, ts };
    this.counterReads++;
    if (!last) return;
    const secs = (ts - last.ts) / 1000;
    const wrap = this.client.counterWrap || 2 ** 32;
    // A counter that goes backwards is a wrap only when the previous value was close to the limit;
    // otherwise it is a reset (box reboot, interface restart) and the sample is skipped
    const plausibleWrap = (prev, cur) => cur >= prev || prev > wrap * 0.75;
    const down = plausibleWrap(last.rx, c.rx) ? counterRate(last.rx, c.rx, secs, { wrap, maxMbps: this._maxRate('down') }) : null;
    const up = plausibleWrap(last.tx, c.tx) ? counterRate(last.tx, c.tx, secs, { wrap, maxMbps: this._maxRate('up') }) : null;
    if (down == null || up == null) {
      this.rejected++;
      this._diagOnce('counter_reject', RATE_LIMIT_MIN, 'info', 'box', this._t('diag.counter_rejected', {
        rx0: last.rx, rx1: c.rx, tx0: last.tx, tx1: c.tx, secs: round(secs), max: Math.round(this._maxRate('down')),
      }));
    }
    if (this.counterReads % 6 === 0) {
      // Raw values once a minute in the detailed log (to check the traffic measurement), with the
      // IP-level WAN interface ("data") of the Livebox for comparison
      this._diag('debug', 'box', this._t('diag.counters', {
        rx: c.rx, tx: c.tx, secs: round(secs), down: round(down) ?? '—', up: round(up) ?? '—', intf: c.intf || this.client.ontKey || '?',
      }));
      if (this.operator === 'orange' || this.operator === 'sosh') this._compareDataCounters().catch(() => {});
    }
    if (down != null) await this._set('netmon_throughput.down', round(down));
    if (up != null) await this._set('netmon_throughput.up', round(up));
  }

  async _compareDataCounters() {
    const d = await this.client.readCounters('data');
    const ts = Date.now();
    const last = this.lastData;
    this.lastData = { ...d, ts };
    if (!last || d.rx == null || last.rx == null) return;
    const secs = (ts - last.ts) / 1000;
    const down = d.rx >= last.rx ? ((d.rx - last.rx) * 8) / secs / 1e6 : null;
    const up = d.tx >= last.tx ? ((d.tx - last.tx) * 8) / secs / 1e6 : null;
    this._diag('debug', 'box', this._t('diag.counters', {
      rx: d.rx, tx: d.tx, secs: round(secs), down: round(down) ?? '—', up: round(up) ?? '—', intf: 'data',
    }));
  }

  async poll() {
    let s;
    try {
      s = await this.client.getStatus();
    } catch (e) {
      this.failures++;
      this.log(`Livebox poll failed (${this.failures}):`, e.message);
      this.lastError = { t: new Date().toISOString(), text: e.message, code: e.code || null };
      if (e.code === 'EAUTH') {
        this._diagOnce('auth', RATE_LIMIT_MIN, 'error', 'box', this._t('diag.box_auth'));
        await this.setUnavailable(this.homey.__('status.auth')).catch(() => {});
      } else if (this.failures >= 3) {
        if (this.failures === 3) this._diag('error', 'box', this._t('diag.box_unreachable', { n: this.failures, error: e.message }));
        await this.setUnavailable(`${this.homey.__('status.unreachable')} (${e.message})`).catch(() => {});
      } else {
        this._diag('debug', 'box', this._t('diag.box_poll_failed', { n: this.failures, error: e.message }));
      }
      throw e;
    }
    if (this.failures >= 3) this._diag('info', 'box', this._t('diag.box_back', { n: this.failures }));
    this.failures = 0;
    this.lastStatus = { t: new Date().toISOString(), ...s, publicIp: undefined, ipv6: undefined };
    if (!this.getAvailable()) await this.setAvailable().catch(() => {});
    await this._apply(s, Date.now());
    return s;
  }

  async _apply(s, ts) {
    const p = this.prev;

    // Fibre / WAN link
    if (p.online != null && p.online !== s.online) {
      if (!s.online) {
        p.downSince = ts;
        this.log('WAN down:', s.gponState, s.connectionState, s.lastError);
        const msg = this._t('diag.wan_down', { state: [s.gponState, s.connectionState, s.lastError].filter(Boolean).join(' / ') || '?' });
        this._diag('error', 'fiber', msg);
        await this._notify('notify_box', msg);
        await this._trigger('wan_down', { state: s.gponState || s.connectionState || '' });
      } else {
        const duration = p.downSince ? Math.round((ts - p.downSince) / 1000) : 0;
        p.downSince = null;
        this.log(`WAN up after ${duration} s`);
        const msg = this._t('diag.wan_up', { minutes: round(duration / 60) });
        this._diag('warn', 'fiber', msg);
        await this._notify('notify_box', msg);
        await this._trigger('wan_up', { duration });
      }
    }

    // Reconnection (connection uptime back to ~0 while the link stayed up) and box reboot
    if (s.boxUptime != null && p.boxUptime != null && s.boxUptime < p.boxUptime) {
      this.log('Box rebooted');
      const msg = this._t('diag.box_rebooted', { hours: round(p.boxUptime / 3600) });
      this._diag('warn', 'box', msg);
      await this._notify('notify_box', msg);
      await this._trigger('box_rebooted');
    } else if (s.wanUptime != null && p.wanUptime != null && s.wanUptime < p.wanUptime && s.online) {
      this.log(`WAN reconnected (previous uptime ${p.wanUptime} s)`);
      this._diag('warn', 'fiber', this._t('diag.wan_reconnected', { hours: round(p.wanUptime / 3600) }));
      await this._trigger('wan_reconnected', { previous: round(p.wanUptime / 3600) });
    }

    // Public IP
    if (s.publicIp && p.publicIp && s.publicIp !== p.publicIp) {
      this.log(`Public IP changed ${p.publicIp} -> ${s.publicIp}`);
      this._diag('info', 'box', this._t('diag.ip_changed'));
      await this._trigger('public_ip_changed', { ip: s.publicIp, previous: p.publicIp });
    }

    // Optical power, 1 dB hysteresis
    const min = Number(this.getSetting('min_rx_power')) || -26;
    if (s.rxPower != null) {
      if (!p.rxLow && s.rxPower < min) {
        p.rxLow = true;
        const msg = this._t('diag.fiber_low', { rx: round(s.rxPower, 2), min });
        this._diag('warn', 'fiber', msg);
        await this._notify('notify_box', msg);
        await this._trigger('fiber_signal_low', { rx: round(s.rxPower, 2) });
      } else if (p.rxLow && s.rxPower >= min + 1) {
        p.rxLow = false;
        this._diag('info', 'fiber', this._t('diag.fiber_ok', { rx: round(s.rxPower, 2) }));
        await this._trigger('fiber_signal_ok', { rx: round(s.rxPower, 2) });
      }
    }

    Object.assign(p, {
      online: s.online,
      boxUptime: s.boxUptime,
      wanUptime: s.wanUptime,
      publicIp: s.publicIp || p.publicIp,
    });
    await this.setStoreValue('prev', p);

    await this._set('netmon_online', s.online);
    await this._set('netmon_power.rx', round(s.rxPower, 2));
    await this._set('netmon_power.tx', round(s.txPower, 2));
    await this._set('netmon_uptime.wan', round(s.wanUptime != null ? s.wanUptime / 3600 : null));
    await this._set('netmon_uptime.box', round(s.boxUptime != null ? s.boxUptime / 3600 : null));
    await this._set('netmon_ip', s.publicIp || '');
    await this._set('netmon_text', s.stateText || (s.online ? 'Up' : 'Down'));
    // Boxes without optical power readings (Bbox, SFR): hide those measurements
    if (s.rxPower == null && !this.getStoreValue('has_power')) {
      for (const cap of ['netmon_power.rx', 'netmon_power.tx']) {
        if (this.hasCapability(cap)) await this.removeCapability(cap).catch(() => {});
      }
    } else if (s.rxPower != null && !this.getStoreValue('has_power')) {
      await this.setStoreValue('has_power', true);
      for (const cap of ['netmon_power.rx', 'netmon_power.tx']) {
        if (!this.hasCapability(cap)) await this.addCapability(cap).catch(() => {});
      }
    }
    await this._updateQuality(s);
    if (s.firmware && this.getStoreValue('firmware') !== s.firmware) {
      await this.setStoreValue('firmware', s.firmware);
      await this.setSettings({ firmware: s.firmware, model: s.model || '' }).catch(() => {});
    }
  }

  /** Latest probe values of the Internet quality device (latency, jitter, loss, latency to the box). */
  _probeValues() {
    try {
      const d = this.homey.drivers.getDriver('internet').getDevices()[0];
      if (!d) return {};
      const v = (c) => (d.hasCapability(c) ? d.getCapabilityValue(c) : null);
      // A round delayed locally (box or Homey busy) is not an Internet latency problem: the LAN part still counts
      if (d.lastRoundLocal) return { loss: v('netmon_loss'), lanLatency: v('netmon_latency.gateway') };
      return { latency: v('netmon_latency'), jitter: v('netmon_jitter'), loss: v('netmon_loss'), lanLatency: v('netmon_latency.gateway') };
    } catch (e) {
      return {};
    }
  }

  /**
   * Internet link quality (0-100 %), smoothed (EMA over ~3 polls) so that one slow probe does not
   * draw a spike: fibre link and optical power from the box, latency / jitter / loss / LAN latency
   * from the Internet quality device.
   */
  async _updateQuality(s) {
    const { score, parts } = linkQuality({ online: s.online, rxPower: s.rxPower, ...this._probeValues() });
    this.quality = !s.online || this.quality == null ? score : this.quality * 0.6 + score * 0.4;
    this.qualityParts = parts;
    const q = Math.round(this.quality);
    await this._set('netmon_quality', q);
    await this.setStoreValue('quality_ema', this.quality);
    if (s.online && q < 50) {
      const weak = Object.entries(parts).filter(([, v]) => v != null && v < 60).map(([k, v]) => `${this.homey.__(`diag.part_${k}`)} ${v}`).join(', ');
      this._diagOnce('quality_low', RATE_LIMIT_MIN, 'warn', 'box', this._t('diag.quality_low', { q, parts: weak || '—' }));
    }
  }

  /** True when the box has a native speed test usable from its local API (Livebox). */
  supportsSpeedtest() {
    return typeof this.client.runSpeedtest === 'function';
  }

  /** Native speed test run by the box (not limited by the Homey Ethernet port). */
  async runSpeedtest() {
    if (!this.supportsSpeedtest()) throw new Error('No native speed test on this box');
    const r = await this.client.runSpeedtest();
    // Results of the box's own test, kept as separate Insights curves on the box device
    await this._set('netmon_download.box', r.download);
    await this._set('netmon_upload.box', r.upload);
    if (r.latency != null) await this._set('netmon_latency.box', r.latency);
    await this.setStoreValue('box_speedtest', { download: r.download, upload: r.upload, latency: r.latency, ts: Date.now() });
    this._diag('info', 'speed', this._t('diag.box_speed', { down: r.download, up: r.upload, latency: r.latency ?? '—' }));
    return r;
  }

  getDiagStatus() {
    const st = this.getStoreValue('box_speedtest');
    return {
      driver: 'livebox',
      id: this.getData().id,
      name: this.getName(),
      kind: 'box',
      host: this.getSetting('host'),
      available: this.getAvailable(),
      online: this.getCapabilityValue('netmon_online'),
      state: this.getCapabilityValue('netmon_text'),
      quality: this.getCapabilityValue('netmon_quality'),
      qualityParts: this.qualityParts,
      rxPower: this.getCapabilityValue('netmon_power.rx'),
      traffic: { down: this.getCapabilityValue('netmon_throughput.down'), up: this.getCapabilityValue('netmon_throughput.up'), rejected: this.rejected },
      lastSpeedtest: st ? { ...st, t: new Date(st.ts).toISOString() } : null,
      lastStatusAt: this.lastStatus ? this.lastStatus.t : null,
      lastError: this.lastError,
    };
  }

  getDiagReport() {
    const values = {};
    for (const c of this.getCapabilities()) values[c] = this.getCapabilityValue(c);
    return { driver: 'livebox', name: this.getName(), status: this.getDiagStatus(), settings: this.getSettings(), values };
  }

  isWanUp() {
    return this.getCapabilityValue('netmon_online') === true;
  }
};
