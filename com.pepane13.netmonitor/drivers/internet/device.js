'use strict';

const Homey = require('homey');
const { probeRound, parseTargets, tcpConnectTime, dnsTime } = require('../../lib/probe');
const { runSpeedtest } = require('../../lib/speedtest');
const { OutageTracker, ThresholdWatch } = require('../../lib/monitor');

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

function formatDuration(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min ${String(sec).padStart(2, '0')} s`;
  return `${sec} s`;
}

module.exports = class InternetDevice extends Homey.Device {
  async onInit() {
    this.probeTimer = null;
    this.speedTimer = null;
    this.speedRunning = null;
    this.lastSource = this.getStoreValue('last_source') || null;
    await this._migrateThresholds();
    this.tracker = new OutageTracker({ confirm: this.getSetting('confirm_rounds') || 2, state: this.getStoreValue('outages') || undefined });
    this.watch = new ThresholdWatch(this._rules(), this.getSetting('consecutive') || 2, this.getStoreValue('watch') || undefined);
    await this._ensureCapabilities();
    if (this.getCapabilityValue('netmon_status') == null) await this._set('netmon_status', 'unknown');
    this._scheduleProbe(2000);
    this._scheduleSpeedtest(true);
    this.log('Internet quality device ready');
  }

  async _ensureCapabilities() {
    for (const c of this.driver.manifest.capabilities) {
      if (!this.hasCapability(c)) await this.addCapability(c).catch((e) => this.error('addCapability', c, e.message));
    }
  }

  /**
   * v1.0 used 60 / 60 Mbit/s for every source (Homey cap). With the Livebox test measuring the full
   * line speed, devices still on those defaults get the Livebox defaults; the old values move to the
   * Homey-test thresholds. Custom values are left untouched.
   */
  async _migrateThresholds() {
    if (this.getStoreValue('thresholds_v2')) return;
    const s = this.getSettings();
    if (s.min_download === 60 && s.min_upload === 60) {
      await this.setSettings({ min_download: 500, min_upload: 400, min_download_homey: 60, min_upload_homey: 60 })
        .catch((e) => this.error('threshold migration', e.message));
      this.log('Speed thresholds migrated to 500 / 400 Mbit/s (Livebox test)');
    }
    await this.setStoreValue('thresholds_v2', true);
  }

  _rules() {
    const s = (k) => Number(this.getSetting(k)) || 0;
    return {
      // Download / upload limits depend on where the test ran (see _evaluateSpeed)
      download: { limit: s(this.lastSource === 'homey' ? 'min_download_homey' : 'min_download'), dir: 'min' },
      upload: { limit: s(this.lastSource === 'homey' ? 'min_upload_homey' : 'min_upload'), dir: 'min' },
      latency: { limit: s('max_latency'), dir: 'max' },
      jitter: { limit: s('max_jitter'), dir: 'max' },
      loss: { limit: s('max_loss'), dir: 'max' },
    };
  }

  async onSettings({ changedKeys }) {
    this.tracker.confirm = Number(this.getSetting('confirm_rounds')) || 2;
    this.watch.setRules(this._rules(), Number(this.getSetting('consecutive')) || 2);
    // Thresholds changed: clear the alert state of the affected metrics so they are re-evaluated
    const map = {
      min_download: 'download', min_upload: 'upload', min_download_homey: 'download', min_upload_homey: 'upload', max_latency: 'latency', max_jitter: 'jitter', max_loss: 'loss',
    };
    for (const k of changedKeys) if (map[k]) this.watch.reset(map[k]);
    if (changedKeys.some((k) => k.startsWith('probe') || k === 'gateway')) this._scheduleProbe(1000);
    if (changedKeys.includes('speedtest_interval')) this._scheduleSpeedtest(false);
    this.homey.setTimeout(() => this._refreshStatus().catch((e) => this.error(e)), 100);
  }

  async onDeleted() {
    this.onUninit();
  }

  onUninit() {
    if (this.probeTimer) this.homey.clearTimeout(this.probeTimer);
    if (this.speedTimer) this.homey.clearTimeout(this.speedTimer);
    this.probeTimer = null;
    this.speedTimer = null;
  }

  async _set(cap, value) {
    if (!this.hasCapability(cap)) return;
    if (this.getCapabilityValue(cap) === value) return;
    await this.setCapabilityValue(cap, value).catch((e) => this.error('set', cap, e.message));
  }

  _trigger(id, tokens = {}) {
    return this.homey.flow.getDeviceTriggerCard(id).trigger(this, tokens).catch((e) => this.error('trigger', id, e.message));
  }

  _time(ts) {
    return new Date(ts).toLocaleTimeString('fr-FR', { timeZone: this.homey.clock.getTimezone(), hour: '2-digit', minute: '2-digit' });
  }

  // ------------------------------------------------------------------ probes

  _scheduleProbe(ms) {
    if (this.probeTimer) this.homey.clearTimeout(this.probeTimer);
    this.probeTimer = this.homey.setTimeout(async () => {
      try {
        await this.probe();
      } catch (e) {
        this.error('probe', e.message);
      }
      this._scheduleProbe((Number(this.getSetting('probe_interval')) || 30) * 1000);
    }, ms);
  }

  async probe() {
    const targets = parseTargets(this.getSetting('probe_targets') || '1.1.1.1:443, 8.8.8.8:443, 9.9.9.9:443');
    const r = await probeRound(targets, { samples: 3, timeout: 3000 });

    let gatewayOk = null;
    let gwSetting = this.getSetting('gateway') || '';
    if (gwSetting === '192.168.1.1:80') {
      // Default value: follow the address of the paired box (e.g. a Bbox answers on 192.168.1.254)
      try {
        const box = this.homey.drivers.getDriver('livebox').getDevices()[0];
        const host = box && String(box.getSetting('host') || '').replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
        if (host) gwSetting = `${host}:80`;
      } catch (e) { /* no box device */ }
    }
    const gw = parseTargets(gwSetting, 80)[0];
    if (gw) {
      try {
        await this._set('netmon_latency.gateway', round1(await tcpConnectTime(gw.host, gw.port, 2000)));
        gatewayOk = true;
      } catch (e) {
        await this._set('netmon_latency.gateway', null);
        gatewayOk = false;
      }
    }
    try {
      await this._set('netmon_dns', Math.round(await dnsTime('www.google.com', 3000)));
    } catch (e) {
      await this._set('netmon_dns', null);
    }

    await this._set('netmon_online', r.online);
    await this._set('netmon_latency', round1(r.latency));
    await this._set('netmon_jitter', round1(r.jitter));
    await this._set('netmon_loss', Math.round(r.loss));

    const ev = this.tracker.update(r.online, Date.now());
    if (ev && ev.type === 'down') {
      const cause = gatewayOk === false ? 'lan' : 'internet';
      this.log(`Internet down since ${new Date(ev.since).toISOString()} (cause: ${cause})`, JSON.stringify(r.perTarget));
      await this._trigger('internet_down', { since: this._time(ev.since), cause });
    } else if (ev && ev.type === 'up') {
      this.log(`Internet restored after ${ev.duration} s`);
      await this._trigger('internet_restored', { duration: ev.duration, duration_text: formatDuration(ev.duration), since: this._time(ev.since) });
    }
    await this._set('netmon_outages', this.tracker.count);
    await this._set('netmon_downtime', round1(this.tracker.downtimeToday() / 60));
    await this.setStoreValue('outages', this.tracker.toJSON());

    // A running speed test saturates the line (bufferbloat): latency samples are not representative
    if (r.online && !this.speedRunning) {
      await this._evaluate('latency', r.latency);
      await this._evaluate('jitter', r.jitter);
      await this._evaluate('loss', r.loss);
    }
    await this._refreshStatus();
    return r;
  }

  async _evaluate(metric, value) {
    const ev = this.watch.update(metric, value);
    if (!ev) return;
    const label = this.homey.__(`metric.${metric}`);
    this.log(`Quality ${ev.type}: ${metric}=${value} (limit ${ev.limit})`);
    if (ev.type === 'degraded') await this._trigger('quality_degraded', { metric: label, value: round1(value), limit: ev.limit });
    else await this._trigger('quality_recovered', { metric: label, value: round1(value) });
    await this.setStoreValue('watch', this.watch.state);
  }

  async _refreshStatus() {
    let status = 'ok';
    if (!this.tracker.online) status = 'down';
    else if (this.watch.degraded().length) status = 'degraded';
    await this._set('netmon_status', status);
  }

  isOnline() {
    return this.tracker.online;
  }

  isQualityOk() {
    return this.tracker.online && this.watch.degraded().length === 0;
  }

  // ------------------------------------------------------------------ speed test

  _scheduleSpeedtest(atStartup) {
    if (this.speedTimer) this.homey.clearTimeout(this.speedTimer);
    this.speedTimer = null;
    const interval = Number(this.getSetting('speedtest_interval')) || 0;
    if (!interval) return;
    const last = this.getStoreValue('last_speedtest') || 0;
    let wait = last + interval * 60000 - Date.now();
    // After a restart, wait at least 2 minutes (Homey busy starting the other apps)
    wait = Math.max(wait, atStartup ? 120000 : 5000);
    this.speedTimer = this.homey.setTimeout(async () => {
      try {
        await this.runSpeedtest();
      } catch (e) {
        this.error('speedtest', e.message);
      }
      this._scheduleSpeedtest(false);
    }, Math.min(wait, 2 ** 31 - 1));
  }

  /** Runs one speed test (concurrent calls share the same run). */
  runSpeedtest() {
    if (this.speedRunning) return this.speedRunning;
    this.speedRunning = this._runSpeedtest().finally(() => { this.speedRunning = null; });
    return this.speedRunning;
  }

  /** Livebox device used for the native speed test, if one is paired and available. */
  _livebox() {
    try {
      return this.homey.drivers.getDriver('livebox').getDevices()
        .find((d) => d.getAvailable() && (typeof d.supportsSpeedtest !== 'function' || d.supportsSpeedtest())) || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Speed test source: the Livebox native test (measured by the box, full line speed) when a Livebox
   * is paired, otherwise / as fallback the Cloudflare test run from Homey (capped by its Ethernet port).
   */
  async _speedtestBySource() {
    const source = this.getSetting('speedtest_source') || 'auto';
    const fromHomey = async () => ({
      ...(await runSpeedtest({
        durationS: Number(this.getSetting('speedtest_duration')) || 8,
        streams: Number(this.getSetting('speedtest_streams')) || 4,
      })),
      source: 'homey',
    });
    if (source === 'homey') return fromHomey();
    const box = this._livebox();
    if (!box) {
      if (source === 'livebox') throw new Error('No available Livebox device');
      return fromHomey();
    }
    try {
      return await box.runSpeedtest();
    } catch (e) {
      if (source === 'livebox') throw e;
      this.log('Livebox speed test failed, falling back to Homey:', e.message);
      return fromHomey();
    }
  }

  async _runSpeedtest() {
    await this.setStoreValue('last_speedtest', Date.now());
    if (!this.tracker.online) throw new Error('Internet is down');
    const started = Date.now();
    let r;
    try {
      r = await this._speedtestBySource();
    } catch (e) {
      this.log('Speed test failed:', e.message);
      await this._trigger('speedtest_failed', { error: e.message });
      throw e;
    }
    this.log(`Speed test (${r.source}): ${r.download} / ${r.upload} Mbit/s, ${r.latency} ms in ${Math.round((Date.now() - started) / 1000)} s (${r.server})`);
    await this._set('netmon_download', r.download);
    await this._set('netmon_upload', r.upload);
    await this._set('netmon_latency.speedtest', r.latency);
    await this.setStoreValue('speedtest', { ...r, ts: Date.now() });
    await this._trigger('speedtest_done', { download: r.download, upload: r.upload, latency: r.latency ?? 0, jitter: r.jitter ?? 0, server: r.server || '' });
    if (r.source !== this.lastSource) {
      // A source change (e.g. fallback to Homey) changes the scale: restart the speed alert counters
      this.lastSource = r.source;
      await this.setStoreValue('last_source', r.source);
      this.watch.reset('download');
      this.watch.reset('upload');
    }
    this.watch.setRules(this._rules());
    await this._evaluate('download', r.download);
    await this._evaluate('upload', r.upload);
    await this._refreshStatus();
    return r;
  }
};
