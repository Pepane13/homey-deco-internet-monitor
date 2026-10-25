'use strict';

// Protocol tests against local fake servers: node test/protocol.test.js
const assert = require('assert');
const net = require('net');
const { LiveboxClient } = require('../com.pepane13.netmonitor/lib/livebox');
const { DecoClient, _internals } = require('../com.pepane13.netmonitor/lib/deco');
const { probeRound, parseTargets } = require('../com.pepane13.netmonitor/lib/probe');
const { runSpeedtest } = require('../com.pepane13.netmonitor/lib/speedtest');
const { fakeLivebox, fakeDeco, fakeSpeed, fakeBbox, fakeSfr, rsaDecrypt, rsaKey } = require('./fakes');
const { BboxClient } = require('../com.pepane13.netmonitor/lib/bbox');
const { SfrClient, _internals: sfrInternals } = require('../com.pepane13.netmonitor/lib/sfrbox');
const { createBoxClient, OPERATORS } = require('../com.pepane13.netmonitor/lib/boxes');

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

(async () => {
  console.log('Livebox 5 (sysbus)');
  const lb = fakeLivebox();
  const lbHost = await lb.start();

  await test('login + full status', async () => {
    const c = new LiveboxClient({ host: lbHost, password: 'secret' });
    const s = await c.getStatus();
    assert.strictEqual(s.online, true);
    assert.strictEqual(s.publicIp, '90.1.2.3');
    assert.strictEqual(s.rxPower, -18.25);
    assert.strictEqual(s.txPower, 2.4);
    assert.strictEqual(s.rxBytes, 1000000);
    assert.strictEqual(s.boxUptime, 864000);
    assert.strictEqual(s.wanUptime, 3600);
    assert.strictEqual(s.firmware, 'SG_LB5_1.2.3');
    assert.strictEqual(s.ontInterface, 'veip0');
    assert.strictEqual(lb.st.logins, 1);
  });

  await test('expired context -> transparent re-login', async () => {
    const c = new LiveboxClient({ host: lbHost, password: 'secret' });
    await c.getStatus();
    lb.st.expire = true;
    const s = await c.getStatus();
    assert.strictEqual(s.online, true);
    assert.strictEqual(lb.st.logins, 3);
  });

  await test('WAN down detected', async () => {
    lb.st.linkState = 'down';
    const s = await new LiveboxClient({ host: lbHost, password: 'secret' }).getStatus();
    assert.strictEqual(s.online, false);
    lb.st.linkState = 'up';
  });

  await test('wrong password -> EAUTH', async () => {
    await assert.rejects(new LiveboxClient({ host: lbHost, password: 'bad' }).getStatus(), (e) => e.code === 'EAUTH');
  });
  await test('native speed test (AutoDiag speedService) returns new results', async () => {
    const c = new LiveboxClient({ host: lbHost, password: 'secret' });
    const r = await c.runSpeedtest({ pollS: 0, sleep: async () => {} });
    assert.deepStrictEqual(r, { download: 912.3, upload: 701.2, latency: 4, jitter: null, server: 'Livebox', source: 'livebox' });
    const r2 = await c.runSpeedtest({ pollS: 0, sleep: async () => {} });
    assert.strictEqual(r2.download, 912.3, 'second run waits for a newer result');
    assert.strictEqual(lb.st.runs, 2);
  });

  await test('native speed test failure detected without waiting for the timeout', async () => {
    lb.st.speedFail = true;
    await assert.rejects(new LiveboxClient({ host: lbHost, password: 'secret' }).runSpeedtest({ pollS: 0, sleep: async () => {} }), (e) => e.code === 'EFAILED');
    lb.st.speedFail = false;
  });

  await test('native speed test refused while another diagnostic runs', async () => {
    lb.st.diagRunning = true; lb.st.pollsLeft = 99;
    await assert.rejects(new LiveboxClient({ host: lbHost, password: 'secret' }).runSpeedtest({ pollS: 0, sleep: async () => {} }), (e) => e.code === 'EBUSY');
    lb.st.diagRunning = false;
  });
  lb.server.close();

  console.log('Bbox (Bouygues)');
  const bb = fakeBbox();
  const bbHost = await bb.start();
  await test('status and 64-bit counters without login', async () => {
    const c = new BboxClient({ host: `http://${bbHost}` });
    const s = await c.getStatus();
    assert.strictEqual(s.online, true);
    assert.strictEqual(s.publicIp, '89.1.2.3');
    assert.strictEqual(s.model, 'Bbox Ultym');
    assert.strictEqual(s.firmware, '23.7.12');
    assert.strictEqual(s.boxUptime, 7200);
    assert.strictEqual(s.stateText, 'Up · FTTH');
    assert.deepStrictEqual(await c.readCounters(), { rx: 5e9, tx: 1e9 });
    assert.strictEqual(bb.st.logins, 0);
  });
  await test('login with BBOX_ID cookie when the box requires it', async () => {
    bb.st.requireAuth = true;
    const c = new BboxClient({ host: `http://${bbHost}`, password: 'bbox-pass' });
    assert.strictEqual((await c.getStatus()).online, true);
    assert.strictEqual(bb.st.logins, 1);
  });
  await test('wrong password refused once, never retried (lockout protection)', async () => {
    const c = new BboxClient({ host: `http://${bbHost}`, password: 'bad' });
    await assert.rejects(c.getStatus(), (e) => e.code === 'EAUTH');
    const before = bb.st.logins;
    await assert.rejects(c.getStatus(), (e) => e.code === 'EAUTH');
    assert.strictEqual(bb.st.logins, before);
    bb.st.requireAuth = false;
  });
  await test('WAN down detected', async () => {
    bb.st.state = 'Down';
    assert.strictEqual((await new BboxClient({ host: `http://${bbHost}` }).getStatus()).online, false);
    bb.st.state = 'Up';
  });
  bb.server.close();

  console.log('SFR Box');
  const sf = fakeSfr();
  const sfHost = await sf.start();
  await test('public status without password, no counters', async () => {
    const c = new SfrClient({ host: sfHost });
    const s = await c.getStatus();
    assert.strictEqual(s.online, true);
    assert.strictEqual(s.publicIp, '93.1.2.3');
    assert.strictEqual(s.model, 'BOX10H-SER-r0');
    assert.strictEqual(s.wanUptime, 86400);
    assert.strictEqual(s.temperature, 48.5);
    assert.strictEqual(s.stateText, 'up · FTTH · fibre up');
    assert.strictEqual(await c.readCounters(), null);
  });
  await test('XML attribute parser and HMAC token hash (sfrbox-api reference values)', async () => {
    assert.deepStrictEqual(sfrInternals.attrs('<rsp stat="ok"><ftth status="up" wanfibre="in"/></rsp>', 'ftth'), { status: 'up', wanfibre: 'in' });
    const crypto = require('crypto');
    const ref = crypto.createHmac('sha256', 'tok').update(crypto.createHash('sha256').update('admin').digest('hex')).digest('hex');
    assert.strictEqual(sfrInternals.hmacHash('tok', 'admin'), ref);
  });
  await test('WAN down detected', async () => {
    sf.st.status = 'down';
    assert.strictEqual((await new SfrClient({ host: sfHost }).getStatus()).online, false);
    sf.st.status = 'up';
  });
  sf.server.close();

  await test('provider registry: Orange/Sosh -> Livebox, Bouygues -> Bbox, SFR -> SFR Box', async () => {
    assert.deepStrictEqual(Object.keys(OPERATORS), ['orange', 'sosh', 'bouygues', 'sfr']);
    assert.strictEqual(createBoxClient('sosh', {}).constructor.name, 'LiveboxClient');
    assert.strictEqual(createBoxClient('bouygues', {}).base, 'https://192.168.1.254');
    assert.strictEqual(createBoxClient('sfr', {}).constructor.name, 'SfrClient');
    assert.strictEqual(typeof createBoxClient('bouygues', {}).runSpeedtest, 'undefined');
  });

  console.log('TP-Link Deco (LuCI, RSA + AES)');
  await test('RSA PKCS#1 v1.5 multi-block round trip (512 and 1024 bits)', async () => {
    for (const bits of [512, 1024]) {
      const k = rsaKey(bits);
      const text = 'k=1234567890123456&i=6543210987654321&h=0123456789abcdef0123456789abcdef&s=1290';
      const hex = _internals.rsaEncrypt(k.n.toString(16), k.e.toString(16), text);
      assert.strictEqual(hex.length % (bits / 4), 0);
      assert.strictEqual(rsaDecrypt(k, hex), text);
    }
  });

  await test('base64 names decoded, raw names kept', async () => {
    assert.strictEqual(_internals.decodeName(Buffer.from('Dépendance').toString('base64')), 'Dépendance');
    assert.strictEqual(_internals.decodeName('Salon'), 'Salon');
  });

  const dc = fakeDeco();
  const dcHost = await dc.start();

  await test('login + devices, performance, clients per node', async () => {
    const c = new DecoClient({ host: dcHost, password: 'owner-pass' });
    const decos = await c.listDecos();
    assert.strictEqual(decos.length, 2);
    assert.deepStrictEqual(decos.map((d) => d.name), ['Salon', 'Dépendance']);
    assert.strictEqual(decos[0].master, true);
    assert.strictEqual(decos[1].backhaul, 'band5');
    assert.strictEqual(decos[1].signal5, 2);
    assert.strictEqual(decos[1].backhaulSpeed, 480);
    const perf = await c.getPerformance();
    assert.deepStrictEqual(perf, { cpu: 23, mem: 61 });
    const byDeco = await c.listClientsByDeco(decos);
    assert.strictEqual(byDeco['AA:BB:CC:00:00:01'].length, 2);
    assert.strictEqual(byDeco['AA:BB:CC:00:00:02'][0].name, 'Clim Dep');
    assert.strictEqual(byDeco['AA:BB:CC:00:00:01'][1].name, 'iPhone de Stéphane');
    assert.strictEqual(dc.st.logins, 1);
  });

  await test('session lost (owner logged in elsewhere) -> one re-login', async () => {
    const c = new DecoClient({ host: dcHost, password: 'owner-pass' });
    await c.listDecos();
    dc.st.expireNext = true;
    const decos = await c.listDecos();
    assert.strictEqual(decos.length, 2);
    assert.strictEqual(dc.st.logins, 3);
  });

  await test('concurrent calls are serialised on one session', async () => {
    const c = new DecoClient({ host: dcHost, password: 'owner-pass' });
    const before = dc.st.logins;
    await Promise.all([c.listDecos(), c.getPerformance(), c.listClients()]);
    assert.strictEqual(dc.st.logins - before, 1);
  });

  await test('wrong password -> EAUTH with attempts left', async () => {
    await assert.rejects(new DecoClient({ host: dcHost, password: 'nope' }).listDecos(), (e) => e.code === 'EAUTH' && /9 attempts/.test(e.message));
  });
  dc.server.close();

  console.log('Probes');
  await test('TCP probe: one target up, one refused', async () => {
    const srv = net.createServer((s) => s.end());
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const closed = net.createServer();
    await new Promise((r) => closed.listen(0, '127.0.0.1', r));
    const deadPort = closed.address().port;
    closed.close();
    const r = await probeRound(parseTargets(`127.0.0.1:${srv.address().port}, 127.0.0.1:${deadPort}`), { samples: 3, timeout: 1000 });
    assert.strictEqual(r.online, true);
    assert.strictEqual(r.reachable, 1);
    assert.strictEqual(Math.round(r.loss), 50);
    assert.ok(r.latency >= 0 && r.latency < 200);
    srv.close();
  });

  await test('target parsing', async () => {
    assert.deepStrictEqual(parseTargets('1.1.1.1:443; dns.google, 9.9.9.9:53'), [
      { host: '1.1.1.1', port: 443 }, { host: 'dns.google', port: 443 }, { host: '9.9.9.9', port: 53 }]);
  });

  console.log('Speed test (fake Cloudflare endpoints)');
  await test('download / upload / latency measured', async () => {
    const sp = fakeSpeed({ downMbps: 60, upMbps: 30 });
    const host = await sp.start();
    const r = await runSpeedtest({ baseUrl: `http://${host}`, durationS: 3, warmupS: 0.5, streams: 4, chunkMb: 2, uploadChunkMb: 1 });
    sp.server.close();
    console.log(`       measured: down ${r.download} Mbit/s, up ${r.upload} Mbit/s, latency ${r.latency} ms, server ${r.server}`);
    assert.ok(r.download > 20 && r.download < 120, `download ${r.download}`);
    assert.ok(r.upload > 1, `upload ${r.upload}`);
    assert.ok(r.latency >= 0 && r.latency < 100);
    assert.strictEqual(r.server, 'MRS');
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
  setTimeout(() => process.exit(process.exitCode || 0), 100);
})();
