'use strict';

const Homey = require('homey');
const { createBoxClient } = require('../../lib/boxes');
const { counterRate } = require('../../lib/monitor');

const COUNTER_INTERVAL = 10000; // 32-bit counters wrap every ~34 s at 1 Gbit/s
const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

module.exports = class LiveboxDevice extends Homey.Device {
  async onInit() {
    this.failures = 0;
    this.prev = this.getStoreValue('prev') || {};
    this.lastCounters = null;
    this._client();
    for (const c of this.driver.manifest.capabilities) {
      if (!this.hasCapability(c)) await this.addCapability(c).catch((e) => this.error('addCapability', c, e.message));
    }
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
    if (!last) return;
    const secs = (ts - last.ts) / 1000;
    const opts = { wrap: this.client.counterWrap || 2 ** 32 };
    const down = counterRate(last.rx, c.rx, secs, opts);
    const up = counterRate(last.tx, c.tx, secs, opts);
    if (down != null) await this._set('netmon_throughput.down', round(down));
    if (up != null) await this._set('netmon_throughput.up', round(up));
  }

  async poll() {
    let s;
    try {
      s = await this.client.getStatus();
    } catch (e) {
      this.failures++;
      this.log(`Livebox poll failed (${this.failures}):`, e.message);
      if (e.code === 'EAUTH') {
        await this.setUnavailable(this.homey.__('status.auth')).catch(() => {});
      } else if (this.failures >= 3) {
        await this.setUnavailable(`${this.homey.__('status.unreachable')} (${e.message})`).catch(() => {});
      }
      throw e;
    }
    this.failures = 0;
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
        await this._trigger('wan_down', { state: s.gponState || s.connectionState || '' });
      } else {
        const duration = p.downSince ? Math.round((ts - p.downSince) / 1000) : 0;
        p.downSince = null;
        this.log(`WAN up after ${duration} s`);
        await this._trigger('wan_up', { duration });
      }
    }

    // Reconnection (connection uptime back to ~0 while the link stayed up) and box reboot
    if (s.boxUptime != null && p.boxUptime != null && s.boxUptime < p.boxUptime) {
      this.log('Box rebooted');
      await this._trigger('box_rebooted');
    } else if (s.wanUptime != null && p.wanUptime != null && s.wanUptime < p.wanUptime && s.online) {
      this.log(`WAN reconnected (previous uptime ${p.wanUptime} s)`);
      await this._trigger('wan_reconnected', { previous: round(p.wanUptime / 3600) });
    }

    // Public IP
    if (s.publicIp && p.publicIp && s.publicIp !== p.publicIp) {
      this.log(`Public IP changed ${p.publicIp} -> ${s.publicIp}`);
      await this._trigger('public_ip_changed', { ip: s.publicIp, previous: p.publicIp });
    }

    // Optical power, 1 dB hysteresis
    const min = Number(this.getSetting('min_rx_power')) || -26;
    if (s.rxPower != null) {
      if (!p.rxLow && s.rxPower < min) {
        p.rxLow = true;
        await this._trigger('fiber_signal_low', { rx: round(s.rxPower, 2) });
      } else if (p.rxLow && s.rxPower >= min + 1) {
        p.rxLow = false;
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
    if (s.firmware && this.getStoreValue('firmware') !== s.firmware) {
      await this.setStoreValue('firmware', s.firmware);
      await this.setSettings({ firmware: s.firmware, model: s.model || '' }).catch(() => {});
    }
  }

  /** True when the box has a native speed test usable from its local API (Livebox). */
  supportsSpeedtest() {
    return typeof this.client.runSpeedtest === 'function';
  }

  /** Native speed test run by the box (not limited by the Homey Ethernet port). */
  runSpeedtest() {
    if (!this.supportsSpeedtest()) return Promise.reject(new Error('No native speed test on this box'));
    return this.client.runSpeedtest();
  }

  isWanUp() {
    return this.getCapabilityValue('netmon_online') === true;
  }
};
