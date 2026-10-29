'use strict';

const Homey = require('homey');
const { probeRound, parseTargets, tcpConnectTime, dnsTime } = require('../../lib/probe');
const { runSpeedtest } = require('../../lib/speedtest');
const { OutageTracker, ThresholdWatch } = require('../../lib/monitor');
const { DayStats, dayKey, timeOf } = require('../../lib/quality');
const { isLocalNetError, interfaceSnapshot } = require('../../lib/netif');

const LOCAL_DELAY_MIN_MS = 20;
const RATE_LIMIT_MIN = 30; // same warning at most once per 30 min

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
    await this._migrateQualityThresholds();
    this.tracker = new OutageTracker({ confirm: this.getSetting('confirm_rounds') || 2, state: this.getStoreValue('outages') || undefined });
    this.watch = new ThresholdWatch(this._rules(), this.getSetting('consecutive') || 2, this.getStoreValue('watch') || undefined);
    await this._ensureCapabilities();
    this.stats = new DayStats(this.getStoreValue('day_stats') || undefined);
    this.stats.roll(this._today());
    this.lastRound = null;
    this.lastError = null;
    this.onceAt = {};
    this.rounds = 0;
    if (this.getCapabilityValue('netmon_status') == null) await this._set('netmon_status', 'unknown');
    this._diag('info', 'app', `${this._t('diag.device_started')} (${this._t('diag.probes_every', { s: Number(this.getSetting('probe_interval')) || 30 })})`);
    if (this.migratedQuality) {
      this._diag('info', 'app', this._t('diag.thresholds_migrated', { values: Object.entries(this.migratedQuality).map(([k, v]) => `${k}=${v}`).join(', ') }));
    }
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

  /**
   * v1.1.1: latency / jitter alerts tuned on real data (one-off spikes of a few seconds are frequent
   * and harmless). Devices still on the v1.0 / v1.1 defaults move to 50 ms / 30 ms / 4 rounds;
   * custom values are left untouched.
   */
  async _migrateQualityThresholds() {
    if (this.getStoreValue('thresholds_v3')) return;
    const s = this.getSettings();
    const next = {};
    if (s.max_latency === 30) next.max_latency = 50;
    if (s.max_jitter === 15) next.max_jitter = 30;
    if (s.consecutive === 2) next.consecutive = 4;
    if (Object.keys(next).length) {
      await this.setSettings(next).catch((e) => this.error('threshold migration', e.message));
      this.log('Quality thresholds migrated', JSON.stringify(next));
      this.migratedQuality = next;
    }
    await this.setStoreValue('thresholds_v3', true);
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
    this._diag('info', 'app', this._t('diag.settings_changed', { keys: changedKeys.join(', ') }));
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
    this.setStoreValue('day_stats', this.stats.toJSON()).catch(() => {});
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
    return timeOf(ts, this.homey.clock.getTimezone());
  }

  _today(ts = Date.now()) {
    return dayKey(ts, this.homey.clock.getTimezone());
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

  /** Logs a message at most once per `minutes` for the same key. Returns true when logged. */
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

  /** Daily summary of the finished day, logged at the first probe of the new day. */
  _rollDay(ts) {
    const done = this.stats.roll(this._today(ts));
    if (!done) return;
    const d = new DayStats(done);
    const v = (m, k) => { const x = d.get(m); return x ? x[k] : '—'; };
    const c = done.counters || {};
    const speeds = (done.events || []).filter((e) => e.startsWith('speed ')).map((e) => e.slice(6));
    this._diag('info', 'day', this._t('diag.summary', {
      day: done.day,
      rounds: c.rounds || 0,
      outages: c.outages || 0,
      downtime: Math.round((c.downtime || 0) / 60),
      lavg: v('latency', 'avg'), lmax: v('latency', 'max'), lmaxAt: d.get('latency') ? this._time(d.get('latency').maxAt) : '—',
      javg: v('jitter', 'avg'), jmax: v('jitter', 'max'),
      gavg: v('lan', 'avg'), gmax: v('lan', 'max'),
      lossRounds: c.loss_rounds || 0,
      alerts: c.alerts || 0,
      tests: speeds.length ? speeds.join(' ; ') : '—',
    }));
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
    const now = Date.now();
    this._rollDay(now);
    const targets = parseTargets(this.getSetting('probe_targets') || '1.1.1.1:443, 8.8.8.8:443, 9.9.9.9:443');
    const gwSetting = this._gatewaySetting();
    const gw = parseTargets(gwSetting, 80)[0];
    // The box is timed before and after the Internet probes: a slow answer on either side means the
    // round was delayed locally (box busy, local network loaded, or Homey itself busy)
    const lanBefore = gw ? await this._lanTime(gw) : null;
    const r = await probeRound(targets, { samples: 3, timeout: 3000 });
    const lanAfter = gw ? await this._lanTime(gw) : null;
    const lanTimes = [lanBefore, lanAfter].filter((v) => v != null);
    let gatewayOk = null;
    let lanLatency = null;
    let lanPeak = null;
    if (gw) {
      gatewayOk = lanTimes.length > 0;
      lanLatency = lanTimes.length ? Math.min(...lanTimes) : null;
      lanPeak = lanTimes.length ? Math.max(...lanTimes) : null;
      await this._set('netmon_latency.gateway', round1(lanLatency));
    }
    const local = this._isLocalDelay(lanPeak);
    this.lastRoundLocal = local;
    let dns = null;
    try {
      dns = await dnsTime('www.google.com', 3000);
      await this._set('netmon_dns', Math.round(dns));
    } catch (e) {
      await this._set('netmon_dns', null);
      this._diagOnce('dns', RATE_LIMIT_MIN, 'warn', 'internet', this._t('diag.dns_failed', { error: e.code || e.message }));
    }
    this.lastRound = { t: new Date(now).toISOString(), ...r, lan: lanLatency, lanPeak, local, dns, speedRunning: !!this.speedRunning };
    this.rounds++;
    this.stats.count('rounds');
    if (local) this.stats.count('local_rounds');
    if (r.online && !this.speedRunning && !local) {
      this.stats.add('latency', r.latency, now);
      this.stats.add('jitter', r.jitter, now);
    }
    this.stats.add('lan', lanLatency, now);
    if (r.loss > 0) this.stats.count('loss_rounds');
    const per = (r.perTarget || []).map((t) => `${t.target} ${t.ok ? `${round1(t.latency)} ms` : (t.error || 'KO')}`).join(', ');
    this._diag('debug', 'internet', this._t('diag.round', {
      latency: round1(r.latency) ?? '—', jitter: round1(r.jitter) ?? '—', loss: Math.round(r.loss), lan: round1(lanLatency) ?? '—', dns: dns == null ? '—' : Math.round(dns), targets: per,
    }) + (this.speedRunning ? ` ${this._t('diag.during_speedtest')}` : '') + (local ? ` ${this._t('diag.local_round', { lan: round1(lanPeak) })}` : ''));
    if (r.online && r.reachable < r.total) {
      this._diagOnce('partial', RATE_LIMIT_MIN, 'info', 'internet', this._t('diag.partial', { ok: r.reachable, total: r.total, targets: per }));
    }
    const homeyLink = this._checkHomeyLink(gatewayOk);
    if (homeyLink) {
      this._diagOnce('homey_link', RATE_LIMIT_MIN, 'warn', 'internet', this._t('diag.homey_link_lost', { error: this.lastLanError || '—', ifaces: this.linkSnapshot.ifaces }));
    } else if (gatewayOk === false) {
      this._diagOnce('lan_down', RATE_LIMIT_MIN, 'warn', 'internet', this._t('diag.lan_unreachable', { target: gwSetting }));
    }
    if (this.rounds % 10 === 0) await this.setStoreValue('day_stats', this.stats.toJSON());

    await this._set('netmon_online', r.online);
    await this._set('netmon_latency', round1(r.latency));
    await this._set('netmon_jitter', round1(r.jitter));
    await this._set('netmon_loss', Math.round(r.loss));

    const ev = this.tracker.update(r.online, Date.now());
    if (ev && ev.type === 'down') {
      const cause = homeyLink ? 'homey' : (gatewayOk === false ? 'lan' : 'internet');
      this.outageCause = cause;
      this.log(`Internet down since ${new Date(ev.since).toISOString()} (cause: ${cause})`, JSON.stringify(r.perTarget), this.linkSnapshot ? JSON.stringify(this.linkSnapshot) : '');
      const key = { homey: 'diag.down_homey', lan: 'diag.down_lan', internet: 'diag.down_internet' }[cause];
      const msg = this._t(key, {
        since: this._time(ev.since), targets: per || '—',
        error: (this.linkSnapshot && this.linkSnapshot.error) || this.lastLanError || '—',
        ifaces: this.linkSnapshot ? this.linkSnapshot.ifaces : interfaceSnapshot().text,
      });
      this.lastError = { t: new Date(now).toISOString(), text: msg };
      this.stats.count('outages');
      this.stats.event(`down ${this._time(ev.since)}`);
      this._diag('error', 'internet', msg);
      await this._notify('notify_internet', msg);
      await this._trigger('internet_down', { since: this._time(ev.since), cause });
    } else if (ev && ev.type === 'up') {
      this.log(`Internet restored after ${ev.duration} s`);
      const msg = this._t('diag.restored', { duration: formatDuration(ev.duration), since: this._time(ev.since) });
      this.stats.count('downtime', ev.duration);
      this._diag('warn', 'internet', msg);
      if (this.outageCause === 'homey') this._diag('info', 'internet', this._t('diag.homey_link_back', { ifaces: interfaceSnapshot().text }));
      this.outageCause = null;
      await this._notify('notify_internet', msg);
      await this._trigger('internet_restored', { duration: ev.duration, duration_text: formatDuration(ev.duration), since: this._time(ev.since) });
    }
    await this._set('netmon_outages', this.tracker.count);
    await this._set('netmon_downtime', round1(this.tracker.downtimeToday() / 60));
    await this.setStoreValue('outages', this.tracker.toJSON());

    // A running speed test saturates the line (bufferbloat): latency samples are not representative
    // A round delayed locally says nothing about the Internet link: latency / jitter are not evaluated
    // (the curves still show them). Loss is always evaluated: a lost connection is not a local delay.
    if (r.online && !this.speedRunning) {
      const ctx = { lan: lanPeak };
      if (!local) {
        await this._evaluate('latency', r.latency, ctx);
        await this._evaluate('jitter', r.jitter, ctx);
      }
      await this._evaluate('loss', r.loss, ctx);
    }
    await this._refreshStatus();
    return r;
  }

  /** Address of the box used for the local latency (defaults to the paired box). */
  _gatewaySetting() {
    const gwSetting = this.getSetting('gateway') || '';
    if (gwSetting !== '192.168.1.1:80') return gwSetting;
    // Default value: follow the address of the paired box (e.g. a Bbox answers on 192.168.1.254)
    try {
      const box = this.homey.drivers.getDriver('livebox').getDevices()[0];
      const host = box && String(box.getSetting('host') || '').replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
      if (host) return `${host}:80`;
    } catch (e) { /* no box device */ }
    return gwSetting;
  }

  async _lanTime(gw) {
    try {
      const ms = await tcpConnectTime(gw.host, gw.port, 2000);
      this.lastLanError = null;
      return ms;
    } catch (e) {
      this.lastLanError = e.code || e.message;
      return null;
    }
  }

  /**
   * Homey lost its own network link when the box fails with a local socket error (ENETUNREACH...)
   * or when no external interface has an IPv4 address any more. The interface state is captured
   * at the first failing round, so the report shows what Homey saw when the link dropped.
   */
  _checkHomeyLink(gatewayOk) {
    if (gatewayOk !== false) {
      this.linkSnapshot = null;
      return false;
    }
    const snap = interfaceSnapshot();
    if (!this.linkSnapshot) this.linkSnapshot = { t: Date.now(), error: this.lastLanError, ifaces: snap.text, hasIPv4: snap.hasIPv4 };
    return isLocalNetError(this.lastLanError) || !snap.hasIPv4;
  }

  /**
   * True when the round was delayed before reaching the Internet: the box answered slowly
   * (>= 20 ms and more than 3 x its usual time of the day, which is about 6 ms on a Livebox).
   */
  _isLocalDelay(lanPeak) {
    if (lanPeak == null) return false;
    const lan = this.stats.get('lan');
    const usual = lan && lan.n >= 10 ? lan.avg : 6;
    return lanPeak >= LOCAL_DELAY_MIN_MS && lanPeak > usual * 3;
  }

  /**
   * Probable location of a latency / jitter / loss problem: when the latency to the box rises too,
   * the delay builds up before the Internet (box busy or local network loaded).
   */
  _causeHint(metric, ctx) {
    if (!ctx || !['latency', 'jitter', 'loss'].includes(metric)) return '';
    const lan = this.stats.get('lan');
    const usual = lan ? lan.avg : null;
    if (ctx.lan == null) return '';
    if (ctx.lan >= 20 && (usual == null || ctx.lan > usual * 2)) return this._t('diag.hint_local', { lan: round1(ctx.lan) });
    return this._t('diag.hint_internet', { lan: round1(ctx.lan) });
  }

  async _evaluate(metric, value, ctx) {
    const ev = this.watch.update(metric, value);
    if (!ev) return;
    const label = this.homey.__(`metric.${metric}`);
    this.log(`Quality ${ev.type}: ${metric}=${value} (limit ${ev.limit})`);
    const unit = ['download', 'upload'].includes(metric) ? 'Mbit/s' : metric === 'loss' ? '%' : 'ms';
    if (ev.type === 'degraded') {
      const msg = `${this._t('diag.degraded', { metric: label, value: round1(value), unit, limit: ev.limit, n: this.watch.consecutive })} ${this._causeHint(metric, ctx)}`.trim();
      this.stats.count('alerts');
      this.stats.event(`alert ${metric} ${this._time(Date.now())}`);
      this._diag('warn', ['download', 'upload'].includes(metric) ? 'speed' : 'internet', msg);
      await this._notify('notify_quality', msg);
    } else {
      this._diag('info', ['download', 'upload'].includes(metric) ? 'speed' : 'internet',
        this._t('diag.recovered', { metric: label, value: round1(value), unit }));
    }
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
      this._diag('info', 'speed', this._t('diag.speed_fallback', { error: e.message }));
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
      this.lastError = { t: new Date().toISOString(), text: `speed test: ${e.message}` };
      this._diag('warn', 'speed', this._t('diag.speed_failed', { error: e.message }));
      await this._trigger('speedtest_failed', { error: e.message });
      throw e;
    }
    const secs = Math.round((Date.now() - started) / 1000);
    this.log(`Speed test (${r.source}): ${r.download} / ${r.upload} Mbit/s, ${r.latency} ms in ${secs} s (${r.server})`);
    this._diag('info', 'speed', this._t('diag.speed_done', {
      source: this.homey.__(`diag.source_${r.source === 'homey' ? 'homey' : 'box'}`), down: r.download, up: r.upload, latency: r.latency ?? '—', secs,
    }));
    this.stats.event(`speed ${this._time(Date.now())} ${r.download}/${r.upload} (${r.source})`);
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

  // ------------------------------------------------------------------ diagnostics (settings page)

  getDiagStatus() {
    const day = (m) => this.stats.get(m);
    const st = this.getStoreValue('speedtest');
    return {
      driver: 'internet',
      id: this.getData().id,
      name: this.getName(),
      kind: 'internet',
      status: this.getCapabilityValue('netmon_status'),
      online: this.tracker.online,
      lastRound: this.lastRound,
      today: {
        latency: day('latency'), jitter: day('jitter'), lan: day('lan'),
        outages: this.tracker.count, downtimeMin: round1(this.tracker.downtimeToday() / 60),
        alerts: this.stats.counters.alerts || 0,
      },
      degraded: this.watch.degraded(),
      lastSpeedtest: st ? { ...st, t: new Date(st.ts).toISOString() } : null,
      lastError: this.lastError,
    };
  }

  getDiagReport() {
    const values = {};
    for (const c of this.getCapabilities()) values[c] = this.getCapabilityValue(c);
    return { driver: 'internet', name: this.getName(), status: this.getDiagStatus(), settings: this.getSettings(), values };
  }
};
