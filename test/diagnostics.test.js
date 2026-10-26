'use strict';

// Diagnostics helpers: node test/diagnostics.test.js
const assert = require('assert');
const path = require('path');

const APP = path.join(__dirname, '..', 'com.pepane13.netmonitor');
const { linkQuality, scale, DayStats, dayKey } = require(`${APP}/lib/quality`);
const { buildReport, maskIp, maskMac } = require(`${APP}/lib/diagreport`);
const { DiagLog } = require(`${APP}/lib/diaglog`);

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.stack}`);
    process.exitCode = 1;
  }
}

console.log('Link quality score');
test('scale is linear between good and bad, clamped, works in both directions', () => {
  assert.strictEqual(scale(20, 20, 100, 10), 100);
  assert.strictEqual(scale(60, 20, 100, 10), 55);
  assert.strictEqual(scale(500, 20, 100, 10), 10);
  assert.strictEqual(scale(-24.5, -21, -28, 10), 55);
  assert.strictEqual(scale(null, 1, 2), null);
});

test('link down = 0, excellent line = 100, missing components ignored', () => {
  assert.strictEqual(linkQuality({ online: false }).score, 0);
  assert.strictEqual(linkQuality({ online: true, rxPower: -18, latency: 8, jitter: 2, loss: 0, lanLatency: 1 }).score, 100);
  assert.strictEqual(linkQuality({ online: true }).score, 100);
});

test('one bad component cannot be hidden by good ones', () => {
  const q = linkQuality({ online: true, rxPower: -18, latency: 8, jitter: 2, loss: 5, lanLatency: 1 });
  assert.strictEqual(q.parts.loss, 50);
  assert.ok(q.score <= 80, q.score);
  const evening = linkQuality({ online: true, rxPower: -21.2, latency: 48, jitter: 41, loss: 0, lanLatency: 75 });
  assert.ok(evening.score > 40 && evening.score < 80, JSON.stringify(evening));
});

console.log('Daily statistics');
test('min / max / average and roll-over return the finished day', () => {
  const d = new DayStats();
  assert.strictEqual(d.roll('2026-10-25'), null);
  d.add('latency', 10, 1000); d.add('latency', 30, 2000); d.add('latency', null);
  d.count('alerts'); d.count('alerts'); d.event('alert latency 19:20');
  assert.deepStrictEqual(d.get('latency'), { avg: 20, min: 10, max: 30, maxAt: 2000, n: 2 });
  const done = d.roll('2026-10-26');
  assert.strictEqual(done.day, '2026-10-25');
  assert.strictEqual(done.counters.alerts, 2);
  assert.strictEqual(d.get('latency'), null);
  assert.strictEqual(new DayStats(done).get('latency').max, 30);
});

test('day key follows the Homey time zone', () => {
  assert.strictEqual(dayKey(Date.parse('2026-10-25T23:30:00Z'), 'Europe/Paris'), '2026-10-26');
  assert.strictEqual(dayKey(Date.parse('2026-10-25T23:30:00Z'), 'UTC'), '2026-10-25');
});

console.log('Diagnostic report');
test('passwords removed, public IP and MAC masked, log included', () => {
  const r = buildReport({
    generated: '2026-10-26T08:00:00Z',
    timeZone: 'Europe/Paris',
    appVersion: '1.1.0',
    homeyVersion: '12.4.0',
    appSettings: { log_level: 'info', notify_quality: true },
    devices: [{
      driver: 'livebox', name: 'Livebox 5', status: { quality: 88, lastStatusAt: '2026-10-26T07:59:00Z' },
      settings: { host: '192.168.1.1', password: 'secret' }, values: { netmon_ip: '86.198.172.93' },
    }, {
      driver: 'deco', name: 'Salon', status: {}, settings: { node_mac: 'AA:BB:CC:00:00:01' }, values: {},
    }],
    log: [{ t: '2026-10-25T18:20:00Z', l: 'warn', s: 'Internet', c: 'internet', m: 'Quality degraded' }],
  });
  assert.ok(!r.text.includes('secret'));
  assert.ok(r.text.includes('86.198.*.*') && !r.text.includes('86.198.172.93'));
  assert.ok(r.text.includes('AA:BB:CC:**:**:01'));
  assert.ok(r.text.includes('2025') === false);
  assert.ok(r.text.includes('2026-10-25 19:20:00 WARN  [internet] Internet: Quality degraded'));
  assert.ok(/quality on/.test(r.text));
  assert.ok(r.filename.startsWith('netmonitor-diagnostic-2026-10-26'));
  assert.strictEqual(maskIp('2a01:cb00:1:2::1'), '2a01:cb00:***');
  assert.strictEqual(maskMac('bad'), 'bad');
});

console.log('Diagnostic log (shared with the TSUN app)');
test('levels filter, ring buffer persisted in the app settings', () => {
  const store = {};
  const timers = [];
  const homey = {
    settings: { get: (k) => store[k], set: (k, v) => { store[k] = v; } },
    setTimeout: (f) => { timers.push(f); return f; },
    clearTimeout() {},
  };
  const log = new DiagLog(homey);
  log.add('debug', 'x', 'app', 'hidden at info level');
  log.add('warn', 'Internet', 'internet', 'w');
  assert.strictEqual(log.get('debug').length, 1);
  store.log_level = 'debug';
  log.add('debug', 'x', 'app', 'shown');
  assert.strictEqual(log.get('warn').length, 1);
  assert.strictEqual(log.get('debug').length, 2);
  log.flush();
  assert.strictEqual(new DiagLog(homey).get('debug').length, 2);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
