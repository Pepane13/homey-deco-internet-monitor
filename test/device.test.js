'use strict';

// End-to-end device tests (Homey mock + local fake Livebox / Deco): node test/device.test.js
const Module = require('module');
const path = require('path');

const resolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'homey' ? path.join(__dirname, 'homey-mock.js') : resolve.call(this, r, ...a);
};

const assert = require('assert');
const APP = path.join(__dirname, '..', 'com.pepane13.netmonitor');
const manifest = require(`${APP}/app.json`);
const drv = (id) => manifest.drivers.find((d) => d.id === id);
const { _trig: trig, _homey: homey } = require('./homey-mock');
const { fakeLivebox, fakeDeco, fakeBbox, fakeSfr } = require('./fakes');
const { OutageTracker, ThresholdWatch, counterRate } = require(`${APP}/lib/monitor`);

// Probe / speed test stubs, installed before the Internet device module is loaded
const probe = require(`${APP}/lib/probe`);
const speed = require(`${APP}/lib/speedtest`);
const stub = { online: true, latency: 6, jitter: 1, loss: 0, gateway: true, speed: { download: 93.4, upload: 91.8, latency: 5.2, jitter: 0.4, server: 'MRS', bytes: 2e8 } };
probe.probeRound = async () => ({ online: stub.online, latency: stub.online ? stub.latency : null, jitter: stub.online ? stub.jitter : null, loss: stub.online ? stub.loss : 100, reachable: stub.online ? 3 : 0, total: 3, perTarget: [] });
probe.tcpConnectTime = async () => { if (!stub.gateway) throw new Error('down'); return stub.gwMs ?? 0.8; };
probe.rttSeries = async () => ({ ...stub.rtt });
stub.rtt = { latency: 3.2, jitter: 0.5, loss: 0, max: 4.1, error: null };
probe.dnsTime = async () => 12;
speed.runSpeedtest = async () => ({ ...stub.speed });

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.stack}`);
    process.exitCode = 1;
  }
}
const fired = (id) => trig.filter((t) => t.id === id);
const clear = () => trig.splice(0);

(async () => {
  console.log('State machines');
  await test('outage confirmed after N rounds, duration and daily counters', async () => {
    const o = new OutageTracker({ confirm: 2 });
    const t0 = new Date('2026-10-25T10:00:00').getTime();
    assert.strictEqual(o.update(false, t0), null);
    const down = o.update(false, t0 + 30000);
    assert.deepStrictEqual(down, { type: 'down', since: t0 });
    assert.strictEqual(o.update(false, t0 + 60000), null);
    const up = o.update(true, t0 + 95000);
    assert.strictEqual(up.type, 'up');
    assert.strictEqual(up.duration, 95);
    assert.strictEqual(o.count, 1);
    assert.strictEqual(o.downtimeToday(t0 + 100000), 95);
    assert.strictEqual(o.update(false, t0 + 120000), null); // a single failed round is not an outage
    assert.strictEqual(o.update(true, t0 + 150000), null);
    assert.strictEqual(o.count, 1);
    o.update(true, new Date('2026-10-26T00:00:05').getTime());
    assert.strictEqual(o.count, 0, 'daily reset');
  });

  await test('threshold watch: N breaches to alert, N good values to clear, 0 = disabled', async () => {
    const w = new ThresholdWatch({ latency: { limit: 30, dir: 'max' }, download: { limit: 0, dir: 'min' } }, 2);
    assert.strictEqual(w.update('latency', 45), null);
    assert.strictEqual(w.update('latency', 50).type, 'degraded');
    assert.strictEqual(w.update('latency', 55), null);
    assert.strictEqual(w.update('latency', 8), null);
    assert.strictEqual(w.update('latency', 45), null);
    assert.strictEqual(w.update('latency', 7), null);
    assert.strictEqual(w.update('latency', 6).type, 'recovered');
    assert.strictEqual(w.update('download', 1), null);
  });

  await test('counter rate with 32-bit wrap and reboot detection', async () => {
    assert.strictEqual(counterRate(1000, 1000 + 12.5e6, 10), 10);
    assert.strictEqual(Math.round(counterRate(2 ** 32 - 1e6, 11.5e6, 10)), 10);
    assert.strictEqual(counterRate(4e8, 1e6, 10), null); // reset by a reboot
  });

  // ------------------------------------------------------------------ Internet device
  // The app (diagnostic log, notifications) is created first, as on Homey
  const App = require(`${APP}/app.js`);
  const app = new App();
  await app.onInit();
  homey.app = app;
  const logged = (re, level) => app.diag.get('debug').filter((e) => re.test(e.m) && (!level || e.l === level));

  console.log('Internet quality device');
  const InternetDevice = require(`${APP}/drivers/internet/device.js`);
  const settings = {};
  for (const g of drv('internet').settings) for (const s of g.children) settings[s.id] = s.value;
  // The original quality tests use the v1.1.0 thresholds (30 ms / 15 ms / 2 rounds), kept as custom values
  const inet = new InternetDevice(drv('internet'), { ...settings, max_latency: 30, max_jitter: 15, consecutive: 2 }, { id: 'internet' }, 'Internet');
  inet.store.thresholds_v3 = true;
  await inet.onInit();

  await test('all capabilities created, status unknown before the first probe', async () => {
    assert.ok(drv('internet').capabilities.every((c) => c in inet.caps));
    assert.strictEqual(inet.caps.netmon_status, 'unknown');
  });

  await test('healthy probe round', async () => {
    await inet.probe();
    assert.strictEqual(inet.caps.netmon_online, true);
    assert.strictEqual(inet.caps.netmon_latency, 6);
    assert.strictEqual(inet.caps['netmon_latency.gateway'], 0.8);
    assert.strictEqual(inet.caps.netmon_dns, 12);
    assert.strictEqual(inet.caps.netmon_status, 'ok');
    assert.strictEqual(trig.length, 0);
  });

  await test('outage: one failed round ignored, second confirms, restore reports duration', async () => {
    stub.online = false;
    await inet.probe();
    assert.strictEqual(fired('internet_down').length, 0);
    await inet.probe();
    assert.strictEqual(fired('internet_down').length, 1);
    assert.strictEqual(fired('internet_down')[0].tokens.cause, 'internet');
    assert.strictEqual(inet.caps.netmon_status, 'down');
    assert.strictEqual(inet.isOnline(), false);
    stub.online = true;
    await inet.probe();
    const r = fired('internet_restored');
    assert.strictEqual(r.length, 1);
    assert.ok(r[0].tokens.duration >= 0 && typeof r[0].tokens.duration_text === 'string');
    assert.strictEqual(inet.caps.netmon_outages, 1);
    assert.strictEqual(inet.caps.netmon_status, 'ok');
    clear();
  });

  await test('outage with the box unreachable is reported as a LAN problem', async () => {
    stub.online = false; stub.gateway = false;
    await inet.probe(); await inet.probe();
    assert.strictEqual(fired('internet_down')[0].tokens.cause, 'lan');
    stub.online = true; stub.gateway = true;
    await inet.probe();
    clear();
  });

  await test('latency alert after 2 consecutive breaches, cleared after 2 good rounds', async () => {
    stub.latency = 48;
    await inet.probe();
    assert.strictEqual(fired('quality_degraded').length, 0);
    await inet.probe();
    const d = fired('quality_degraded');
    assert.strictEqual(d.length, 1);
    assert.deepStrictEqual(d[0].tokens, { metric: 'Latency', value: 48, limit: 30 });
    assert.strictEqual(inet.caps.netmon_status, 'degraded');
    assert.strictEqual(inet.isQualityOk(), false);
    stub.latency = 6;
    await inet.probe(); await inet.probe();
    assert.strictEqual(fired('quality_recovered').length, 1);
    assert.strictEqual(inet.caps.netmon_status, 'ok');
    clear();
  });

  await test('speed test sets capabilities and triggers; low download raises an alert', async () => {
    const r = await inet.runSpeedtest();
    assert.strictEqual(r.download, 93.4);
    assert.strictEqual(inet.caps.netmon_download, 93.4);
    assert.strictEqual(inet.caps['netmon_latency.speedtest'], 5.2);
    assert.strictEqual(fired('speedtest_done')[0].tokens.server, 'MRS');
    stub.speed.download = 40;
    await inet.runSpeedtest(); await inet.runSpeedtest();
    assert.strictEqual(fired('quality_degraded')[0].tokens.metric, 'Download');
    stub.speed.download = 93;
    clear();
  });

  await test('latency samples taken during a speed test are not evaluated', async () => {
    stub.latency = 120;
    inet.speedRunning = Promise.resolve();
    await inet.probe(); await inet.probe(); await inet.probe();
    inet.speedRunning = null;
    assert.strictEqual(fired('quality_degraded').length, 0);
    assert.strictEqual(inet.caps.netmon_latency, 120, 'value still recorded for the chart');
    stub.latency = 6;
    await inet.probe();
    clear();
  });

  await test('speed test source: Livebox when paired, Homey fallback on failure, Homey forced', async () => {
    const box = { getAvailable: () => true, fail: false, runSpeedtest: async () => { if (box.fail) throw new Error('busy'); return { download: 912.3, upload: 701.2, latency: 4, jitter: null, server: 'Livebox', source: 'livebox' }; } };
    homey.registry.livebox = [box];
    let r = await inet.runSpeedtest();
    assert.strictEqual(r.source, 'livebox');
    assert.strictEqual(inet.caps.netmon_download, 912.3);
    box.fail = true;
    r = await inet.runSpeedtest();
    assert.strictEqual(r.source, 'homey', 'fallback to the Homey test');
    inet.settings.speedtest_source = 'livebox';
    await assert.rejects(inet.runSpeedtest());
    assert.strictEqual(fired('speedtest_failed').length, 1);
    box.fail = false;
    inet.settings.speedtest_source = 'homey';
    r = await inet.runSpeedtest();
    assert.strictEqual(r.source, 'homey');
    inet.settings.speedtest_source = 'auto';
    homey.registry.livebox = [];
    clear();
  });

  await test('v1.0 default thresholds (60/60) migrated to Livebox defaults, custom values kept', async () => {
    const old = new InternetDevice(drv('internet'), { ...settings, min_download: 60, min_upload: 60 }, { id: 'internet' }, 'Internet');
    await old._migrateThresholds();
    assert.deepStrictEqual([old.settings.min_download, old.settings.min_upload, old.settings.min_download_homey], [500, 400, 60]);
    const custom = new InternetDevice(drv('internet'), { ...settings, min_download: 300, min_upload: 60 }, { id: 'internet' }, 'Internet');
    await custom._migrateThresholds();
    assert.strictEqual(custom.settings.min_download, 300);
  });

  await test('Livebox result evaluated against the Livebox thresholds', async () => {
    const box = { getAvailable: () => true, runSpeedtest: async () => ({ download: 350, upload: 300, latency: 4, jitter: null, server: 'Livebox', source: 'livebox' }) };
    homey.registry.livebox = [box];
    await inet.runSpeedtest();
    await inet.runSpeedtest();
    const d = fired('quality_degraded').filter((t) => t.tokens.metric === 'Download');
    assert.strictEqual(d.length, 1);
    assert.strictEqual(d[0].tokens.limit, 500);
    homey.registry.livebox = [];
    await inet.runSpeedtest(); // back to Homey: counters restarted on the Homey scale
    assert.strictEqual(inet.watch.state.download.bad, false);
    clear();
  });

  await test('concurrent speed test requests share one run', async () => {
    let runs = 0;
    const prev = speed.runSpeedtest;
    // The device holds its own reference: count through the stubbed result instead
    stub.speed.server = 'MRS';
    const [a, b] = await Promise.all([inet.runSpeedtest(), inet.runSpeedtest()]);
    runs = fired('speedtest_done').length;
    assert.strictEqual(a, b);
    assert.strictEqual(runs, 1);
    speed.runSpeedtest = prev;
    clear();
  });

  await test('diagnostic log: outage as error + notification, restore as warning', async () => {
    homey.notes.length = 0;
    stub.online = false;
    await inet.probe(); await inet.probe();
    assert.strictEqual(logged(/^Internet down since/, 'error').length >= 1, true);
    assert.ok(homey.notes.some((n) => /^Internet down since/.test(n)));
    stub.online = true;
    await inet.probe();
    assert.ok(logged(/^Internet back after/, 'warn').length >= 1);
    assert.ok(homey.notes.some((n) => /^Internet back after/.test(n)));
    clear();
  });

  await test('round delayed locally (slow box): latency not evaluated, logged as local, loss still evaluated', async () => {
    homey.notes.length = 0;
    const n0 = logged(/^Quality degraded: Latency/, 'warn').length;
    const l0 = inet.stats.counters.local_rounds || 0;
    homey.settings.set('log_level', 'debug');
    stub.latency = 48; stub.gwMs = 45;
    await inet.probe(); await inet.probe(); await inet.probe();
    assert.strictEqual(logged(/^Quality degraded: Latency/, 'warn').length, n0, 'no Internet latency alert');
    assert.strictEqual(inet.lastRoundLocal, true);
    assert.strictEqual((inet.stats.counters.local_rounds || 0) - l0, 3);
    assert.strictEqual(inet.caps.netmon_latency, 48, 'value still recorded for the chart');
    assert.ok(logged(/delayed locally: box answered in 45 ms/, 'debug').length >= 1);
    assert.ok(!homey.notes.some((n) => /Quality degraded/.test(n)));
    homey.settings.set('log_level', 'info');
    stub.latency = 6; stub.gwMs = 0.8;
    await inet.probe();
    assert.strictEqual(inet.lastRoundLocal, false);
    clear();
  });

  await test('latency alert with a normal box is attributed to the Internet side; not notified by default', async () => {
    homey.notes.length = 0;
    const n0 = logged(/^Quality degraded: Latency 48 ms/, 'warn').length;
    stub.latency = 48; stub.gwMs = 0.8;
    await inet.probe(); await inet.probe();
    const d = logged(/^Quality degraded: Latency 48 ms/, 'warn').slice(n0);
    assert.strictEqual(d.length, 1);
    assert.ok(/Latency to the box is normal/.test(d[0].m), d[0].m);
    assert.ok(!homey.notes.some((n) => /Quality degraded/.test(n)), 'quality alerts are off by default');
    stub.latency = 6;
    await inet.probe(); await inet.probe();
    assert.ok(logged(/^Latency back to normal/, 'info').length >= 1);
    clear();
  });

  await test('v1.1.0 default quality thresholds migrated to 50 ms / 30 ms / 4 rounds, custom values kept', async () => {
    const old = new InternetDevice(drv('internet'), { ...settings, max_latency: 30, max_jitter: 15, consecutive: 2 }, { id: 'internet' }, 'Internet');
    await old._migrateQualityThresholds();
    assert.deepStrictEqual([old.settings.max_latency, old.settings.max_jitter, old.settings.consecutive], [50, 30, 4]);
    const custom = new InternetDevice(drv('internet'), { ...settings, max_latency: 40, max_jitter: 15, consecutive: 3 }, { id: 'internet' }, 'Internet');
    await custom._migrateQualityThresholds();
    assert.deepStrictEqual([custom.settings.max_latency, custom.settings.max_jitter, custom.settings.consecutive], [40, 30, 3]);
    await custom._migrateQualityThresholds();
    assert.strictEqual(custom.store.thresholds_v3, true);
    assert.deepStrictEqual([settings.max_latency, settings.max_jitter, settings.consecutive], [50, 30, 4], 'new defaults');
  });

  await test('daily summary logged at the first probe of a new day', async () => {
    inet.stats.roll('2000-01-01');
    inet.stats.add('latency', 12); inet.stats.add('latency', 30); inet.stats.count('alerts');
    await inet.probe();
    const sm = logged(/^Summary of 2000-01-01/, 'info');
    assert.strictEqual(sm.length, 1);
    assert.ok(/average latency 21 ms \(max 30 ms/.test(sm[0].m), sm[0].m);
    assert.ok(/alerts 1/.test(sm[0].m));
    clear();
  });

  await test('settings page status of the Internet device', async () => {
    const st = inet.getDiagStatus();
    assert.strictEqual(st.kind, 'internet');
    assert.strictEqual(st.lastRound && st.lastRound.latency, stub.latency, JSON.stringify(st.lastRound));
    assert.ok(st.today.latency);
    clear();
  });

  // ------------------------------------------------------------------ Livebox device
  console.log('Livebox device');
  const lb = fakeLivebox({ password: 'secret' });
  const lbHost = await lb.start();
  const LiveboxDevice = require(`${APP}/drivers/livebox/device.js`);
  const box = new LiveboxDevice(drv('livebox'), { host: lbHost, username: 'admin', password: 'secret', poll_interval: 60, min_rx_power: -26 }, { id: 'lb' }, 'Livebox');
  await box.onInit();

  await test('first poll fills every measurement, no trigger', async () => {
    await box.poll();
    assert.strictEqual(box.caps.netmon_online, true);
    assert.strictEqual(box.caps['netmon_power.rx'], -18.25);
    assert.strictEqual(box.caps['netmon_uptime.wan'], 1);
    assert.strictEqual(box.caps['netmon_uptime.box'], 240);
    assert.strictEqual(box.caps.netmon_ip, '90.1.2.3');
    assert.strictEqual(box.caps.netmon_text, 'O5_Operation · GPON');
    assert.strictEqual(box.settings.firmware, 'SG_LB5_1.2.3');
    assert.strictEqual(trig.length, 0);
  });

  await test('traffic from 10-second counters', async () => {
    await box.pollCounters();
    lb.st.rx += 125e6; lb.st.tx += 12.5e6;
    box.lastCounters.ts -= 10000;
    await box.pollCounters();
    assert.ok(Math.abs(box.caps['netmon_throughput.down'] - 100) < 1, `down ${box.caps['netmon_throughput.down']}`);
    assert.ok(Math.abs(box.caps['netmon_throughput.up'] - 10) < 1);
  });

  await test('fibre down / up, reconnection, IP change, weak signal', async () => {
    lb.st.linkState = 'down';
    await box.poll();
    assert.strictEqual(fired('wan_down').length, 1);
    assert.strictEqual(box.isWanUp(), false);
    lb.st.linkState = 'up'; lb.st.wanUptime = 20; lb.st.ip = '90.1.2.99'; lb.st.rxPower = -27500;
    await box.poll();
    assert.strictEqual(fired('wan_up').length, 1);
    assert.strictEqual(fired('wan_reconnected').length, 1);
    assert.strictEqual(fired('wan_reconnected')[0].tokens.previous, 1);
    assert.deepStrictEqual(fired('public_ip_changed')[0].tokens, { ip: '90.1.2.99', previous: '90.1.2.3' });
    assert.strictEqual(fired('fiber_signal_low')[0].tokens.rx, -27.5);
    lb.st.rxPower = -25500; // within the 1 dB hysteresis
    await box.poll();
    assert.strictEqual(fired('fiber_signal_ok').length, 0);
    lb.st.rxPower = -20000;
    await box.poll();
    assert.strictEqual(fired('fiber_signal_ok').length, 1);
    clear();
  });

  await test('Internet link quality score (fibre + probes) as an Insights curve', async () => {
    homey.registry.internet = [inet];
    box.quality = null;
    await box.poll();
    assert.ok(box.caps.netmon_quality >= 90, `quality ${box.caps.netmon_quality} ${JSON.stringify(box.qualityParts)} ${JSON.stringify(box._probeValues())}`);
    inet.caps.netmon_latency = 150; inet.caps.netmon_jitter = 60; inet.caps.netmon_loss = 20;
    box.quality = null;
    await box.poll();
    assert.ok(box.caps.netmon_quality < 50, `quality ${box.caps.netmon_quality}`);
    assert.ok(logged(/^Poor Internet link quality/, 'warn').length >= 1);
    inet.caps.netmon_latency = 6; inet.caps.netmon_jitter = 1; inet.caps.netmon_loss = 0;
    homey.registry.internet = [];
  });

  await test('box speed test stored as separate box curves', async () => {
    const real = box.client.runSpeedtest.bind(box.client);
    box.client.runSpeedtest = () => real({ pollS: 0, sleep: async () => {} });
    const r = await box.runSpeedtest();
    assert.strictEqual(r.download, 912.3);
    assert.strictEqual(box.caps['netmon_download.box'], 912.3);
    assert.strictEqual(box.caps['netmon_upload.box'], 701.2);
    assert.strictEqual(box.caps['netmon_latency.box'], 4);
    assert.ok(logged(/^Box speed test: 912.3 Mbit\/s down/, 'info').length === 1);
  });

  await test('impossible traffic (above the measured line capacity) or counter reset is discarded', async () => {
    await box.pollCounters();
    const before = box.caps['netmon_throughput.down'];
    lb.st.rx += 2e9; // 1600 Mbit/s over 10 s on a 912 Mbit/s line
    box.lastCounters.ts -= 10000;
    await box.pollCounters();
    assert.strictEqual(box.caps['netmon_throughput.down'], before);
    assert.ok(logged(/^Traffic sample discarded/).length >= 1);
    lb.st.rx = 1000; // counter reset (reboot), far from the 32-bit limit: not a wrap
    box.lastCounters.ts -= 10000;
    await box.pollCounters();
    assert.strictEqual(box.caps['netmon_throughput.down'], before);
    lb.st.rx += 12.5e6;
    box.lastCounters.ts -= 10000;
    await box.pollCounters();
    assert.ok(Math.abs(box.caps['netmon_throughput.down'] - 10) < 1);
  });

  await test('wrong password -> unavailable with explicit message', async () => {
    box.settings.password = 'bad';
    box._client();
    await assert.rejects(box.poll());
    assert.strictEqual(box.available, false);
    assert.ok(/password/.test(box.unavailableMessage));
    box.settings.password = 'secret';
    box._client();
    await box.poll();
    assert.strictEqual(box.available, true);
  });
  lb.server.close();

  console.log('Internet box device: Bouygues and SFR');
  await test('Bbox: status, 64-bit traffic, optical power hidden, no native speed test', async () => {
    const bb = fakeBbox();
    const host = await bb.start();
    const d = new LiveboxDevice(drv('livebox'), { operator: 'bouygues', host: `http://${host}`, password: '', poll_interval: 60, min_rx_power: -26 }, { id: 'bb' }, 'Bbox');
    await d.onInit();
    await d.poll();
    assert.strictEqual(d.caps.netmon_online, true);
    assert.strictEqual(d.caps.netmon_ip, '89.1.2.3');
    assert.strictEqual(d.caps.netmon_text, 'Up · FTTH');
    assert.ok(!('netmon_power.rx' in d.caps), 'optical power removed');
    await d.pollCounters();
    bb.st.rx += 250e6;
    d.lastCounters.ts -= 10000;
    await d.pollCounters();
    assert.ok(Math.abs(d.caps['netmon_throughput.down'] - 200) < 1, `down ${d.caps['netmon_throughput.down']}`);
    assert.strictEqual(d.supportsSpeedtest(), false);
    d.onUninit();
    bb.server.close();
  });

  await test('SFR Box: status without password, traffic indicators removed', async () => {
    const sf = fakeSfr();
    const host = await sf.start();
    const d = new LiveboxDevice(drv('livebox'), { operator: 'sfr', host, password: '', poll_interval: 60, min_rx_power: -26 }, { id: 'sfr' }, 'SFR');
    await d.onInit();
    await d.poll();
    await d.pollCounters();
    assert.strictEqual(d.caps.netmon_online, true);
    assert.strictEqual(d.caps['netmon_uptime.wan'], 24);
    assert.ok(!('netmon_throughput.down' in d.caps) && !('netmon_power.rx' in d.caps));
    assert.strictEqual(d.settings.model, 'BOX10H-SER-r0');
    d.onUninit();
    sf.server.close();
  });

  // ------------------------------------------------------------------ Deco devices
  console.log('Deco devices (shared session)');
  const dc = fakeDeco({ password: 'owner-pass' });
  const dcHost = await dc.start();
  const DecoDevice = require(`${APP}/drivers/deco/device.js`);
  const dset = { host: dcHost, password: 'owner-pass', poll_interval: 60, min_signal: 2, min_speed: 150 };
  const master = new DecoDevice(drv('deco'), dset, { id: 'AA:BB:CC:00:00:01' }, 'Salon');
  const sat = new DecoDevice(drv('deco'), dset, { id: 'AA:BB:CC:00:00:02' }, 'Dépendance');
  for (const c of drv('deco').capabilities) { master.caps[c] = null; sat.caps[c] = null; }
  await master.onInit();
  await sat.onInit();
  const hub = app.decoHubs.get(dcHost);

  await test('latency from Homey to each Deco (Insights)', async () => {
    await hub.poll();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(master.caps.netmon_latency, 3.2);
    assert.strictEqual(sat.caps.netmon_jitter, 0.5);
    assert.strictEqual(sat.getDiagStatus().latency.latency, 3.2);
    stub.rtt = { latency: 80, jitter: 20, loss: 0, max: 120, error: null };
    sat.settings.max_latency = 50;
    await hub.poll();
    await new Promise((r) => setImmediate(r));
    assert.ok(logged(/^High latency to this node: 80 ms/, 'warn').length >= 1);
    stub.rtt = { latency: 3.2, jitter: 0.5, loss: 0, max: 4.1, error: null };
  });

  await test('two devices share one hub and one login', async () => {
    assert.strictEqual(app.decoHubs.size, 1);
    assert.strictEqual(hub.subscribers.size, 2);
    await hub.poll();
    assert.strictEqual(dc.st.logins, 1);
  });

  await test('master: network-wide clients, load, internet; satellite: backhaul', async () => {
    assert.strictEqual(master.caps['netmon_clients.total'], 3);
    assert.strictEqual(master.caps['netmon_clients.band5'], 1);
    assert.strictEqual(master.caps['netmon_clients.band24'], 1);
    assert.strictEqual(master.caps['netmon_clients.wired'], 1);
    assert.strictEqual(master.caps['netmon_load.cpu'], 23);
    assert.strictEqual(master.caps['netmon_online.internet'], true);
    assert.strictEqual(master.caps.netmon_clients, 2);
    assert.strictEqual(master.caps.netmon_text, 'Main Deco (connected to the box)');
    assert.ok(!('netmon_speed' in master.caps));
    assert.strictEqual(sat.caps.netmon_clients, 1);
    assert.strictEqual(sat.caps['netmon_signal.band5'], 2);
    assert.strictEqual(sat.caps.netmon_speed, 480);
    assert.strictEqual(sat.caps.netmon_text, '5 GHz · 480 Mbit/s');
    assert.strictEqual(master.caps['netmon_throughput.down'], 21);
    assert.strictEqual(master.caps['netmon_throughput.up'], 4.5);
    assert.strictEqual(sat.caps['netmon_throughput.down'], 0);
    assert.strictEqual(master.caps.netmon_rate, '↓ 21  ↑ 4.5 Mbit/s');
    assert.ok(/^2\/3 \(module\) · 2\/3 \(global\) · fields: .*down_speed/.test(master.settings.diag_rates), master.settings.diag_rates);
    assert.strictEqual(sat.settings.node_ip, '192.168.68.2');
    assert.strictEqual(sat.settings.node_role, 'Satellite');
    assert.strictEqual(master.settings.node_ip, '192.168.68.1');
    assert.strictEqual(master.settings.node_model, 'X50');
    assert.ok(!('netmon_clients.total' in sat.caps));
    assert.strictEqual(trig.length, 0);
  });

  await test('rates missing in per-node lists are taken from the global list', async () => {
    const fake = dc.st;
    const saved = JSON.parse(JSON.stringify(fake.clients));
    // Per-node lists without rates, global list with rates
    const strip = (l) => l.map((c) => ({ ...c, down_speed: 0, up_speed: 0 }));
    const perNode = { 'AA-BB-CC-00-00-01': strip(saved['AA-BB-CC-00-00-01']), 'AA-BB-CC-00-00-02': strip(saved['AA-BB-CC-00-00-02']) };
    fake.globalOverride = Object.values(saved).flat();
    fake.clients = perNode;
    await hub.poll();
    assert.strictEqual(master.caps['netmon_throughput.down'], 21);
    assert.ok(/^0\/3 \(module\) · 2\/3 \(global\)/.test(master.settings.diag_rates), master.settings.diag_rates);
    fake.clients = saved;
    fake.globalOverride = null;
    await hub.poll();
  });

  await test('client connected / disconnected on the right node', async () => {
    dc.st.clients['AA-BB-CC-00-00-02'].push({ mac: '11-22-33-44-55-09', name: Buffer.from('Tesla').toString('base64'), ip: '192.168.68.30', online: true, connection_type: 'band2_4', interface: 'iot' });
    dc.st.clients['AA-BB-CC-00-00-01'].splice(1, 1); // iPhone leaves
    await hub.poll();
    const c = fired('client_connected');
    assert.strictEqual(c.length, 1);
    assert.strictEqual(c[0].device, 'Dépendance');
    assert.deepStrictEqual(c[0].tokens, { name: 'Tesla', mac: '11:22:33:44:55:09', ip: '192.168.68.30', band: '2.4 GHz', network: 'iot' });
    const d = fired('client_disconnected');
    assert.strictEqual(d.length, 1);
    assert.strictEqual(d[0].device, 'Salon');
    assert.strictEqual(d[0].tokens.name, 'iPhone de Stéphane');
    clear();
  });

  await test('condition: client search across the mesh by name, IP or MAC', async () => {
    assert.strictEqual(master.isClientConnected('tesla'), true);
    assert.strictEqual(master.isClientConnected('192.168.68.12'), true);
    assert.strictEqual(sat.isClientConnected('11-22-33-44-55-01'), true);
    assert.strictEqual(master.isClientConnected('iphone'), false);
  });

  await test('weak backhaul after 2 polls, then back to normal', async () => {
    Object.assign(dc.st.decos[1], { backhual_speed: 90, signal_level: { band2_4: '2', band5: '1' } });
    await hub.poll();
    assert.strictEqual(fired('backhaul_weak').length, 0);
    await hub.poll();
    assert.deepStrictEqual(fired('backhaul_weak')[0].tokens, { signal: 1, speed: 90 });
    Object.assign(dc.st.decos[1], { backhual_speed: 480, signal_level: { band2_4: '3', band5: '3' } });
    await hub.poll(); await hub.poll();
    assert.strictEqual(fired('backhaul_ok').length, 1);
    clear();
  });

  await test('satellite offline then online with duration', async () => {
    dc.st.decos[1].group_status = 'disconnected';
    await hub.poll();
    assert.strictEqual(fired('node_offline').length, 1);
    assert.strictEqual(fired('node_offline')[0].device, 'Dépendance');
    assert.strictEqual(sat.isOnline(), false);
    assert.ok(homey.notes.some((n) => n === 'Dépendance : node offline'), JSON.stringify(homey.notes));
    assert.ok(logged(/^node offline$/, 'error').some((e) => e.s === 'Dépendance'));
    dc.st.decos[1].group_status = 'connected';
    await hub.poll();
    assert.strictEqual(fired('node_online').length, 1);
    clear();
  });

  await test('owner session stolen by the mobile app -> silent re-login', async () => {
    const before = dc.st.logins;
    dc.st.expireNext = true;
    await hub.poll();
    assert.strictEqual(dc.st.logins, before + 1);
    assert.strictEqual(master.available, true);
  });

  await test('wrong password -> both devices unavailable with the owner-account hint', async () => {
    hub.setCredentials(dcHost, 'manager-pass');
    await assert.rejects(hub.poll());
    assert.strictEqual(master.available, false);
    assert.ok(/owner/.test(sat.unavailableMessage));
    hub.setCredentials(dcHost, 'owner-pass');
    await hub.poll();
    assert.strictEqual(master.available && sat.available, true);
  });

  await test('hub released when the last device is removed', async () => {
    master.onDeleted();
    sat.onDeleted();
    assert.strictEqual(app.decoHubs.size, 0);
  });
  dc.server.close();

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
  setTimeout(() => process.exit(process.exitCode || 0), 100);
})();
