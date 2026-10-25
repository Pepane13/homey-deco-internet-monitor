'use strict';

// Local fake servers reproducing the Livebox 5 sysbus API, the Deco LuCI API and the Cloudflare speed endpoints.
const http = require('http');
const crypto = require('crypto');

const b64urlToBig = (s) => BigInt(`0x${Buffer.from(s, 'base64url').toString('hex')}`);
const { modPow } = require('../com.pepane13.netmonitor/lib/deco')._internals;

function rsaKey(bits) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: bits });
  const jwk = privateKey.export({ format: 'jwk' });
  return { n: b64urlToBig(jwk.n), e: b64urlToBig(jwk.e), d: b64urlToBig(jwk.d), k: bits / 8 };
}

/** Decrypts the TP-Link concatenated PKCS#1 v1.5 blocks. */
function rsaDecrypt(key, hex) {
  const blockHex = key.k * 2;
  let out = Buffer.alloc(0);
  for (let i = 0; i < hex.length; i += blockHex) {
    const m = modPow(BigInt(`0x${hex.slice(i, i + blockHex)}`), key.d, key.n);
    const buf = Buffer.from(m.toString(16).padStart(blockHex, '0'), 'hex');
    if (buf[0] !== 0 || buf[1] !== 2) throw new Error('bad padding');
    out = Buffer.concat([out, buf.subarray(buf.indexOf(0, 2) + 1)]);
  }
  return out.toString('utf8');
}

function readBody(req) {
  return new Promise((resolve) => {
    const c = [];
    req.on('data', (x) => c.push(x));
    req.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`127.0.0.1:${server.address().port}`)));
}

// ---------------------------------------------------------------- Livebox
function fakeLivebox({ password = 'secret' } = {}) {
  const st = {
    linkState: 'up', connectionState: 'Bound', ip: '90.1.2.3', rx: 1000000, tx: 500000,
    rxPower: -18250, txPower: 2400, wanUptime: 3600, logins: 0, calls: [], runs: 0,
  };
  const ctx = 'CTX-123';
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req) || '{}');
    const send = (o, extra = {}) => { res.writeHead(200, { 'Content-Type': 'application/json', ...extra }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization === 'X-Sah-Login') {
      st.logins++;
      if (body.parameters.password !== password) return send({ status: null, errors: [{ error: 13, description: 'Permission denied' }] });
      return send({ status: 0, data: { contextID: ctx, username: 'admin', groups: 'http,admin' } }, { 'Set-Cookie': '9a8b7c/sessid=XYZ; path=/; HttpOnly' });
    }
    if (req.headers['x-context'] !== ctx || !String(req.headers.cookie).includes('sessid=XYZ') || st.expire) {
      st.expire = false;
      return send({ result: { status: null, errors: [{ error: 13, description: 'Permission denied', info: body.service }] } });
    }
    st.calls.push(`${body.service}:${body.method}`);
    const r = (status, data) => send({ result: { status, data } });
    switch (`${body.service}:${body.method}`) {
      case 'sysbus.NMC:getWANStatus':
        return r(true, { LinkType: 'gpon', LinkState: st.linkState, ConnectionState: st.connectionState, WanState: 'up', GponState: 'O5_Operation', IPAddress: st.ip, LastConnectionError: 'None' });
      case 'sysbus.HomeLan.Interface:get':
        return r({ eth4: { Alias: 'Eth', FriendlyName: 'Eth4' }, veip0: { Alias: 'Others', FriendlyName: 'WAN_GPON' } });
      case 'sysbus.DeviceInfo:get':
        return r({ ModelName: 'Livebox Fibre', SoftwareVersion: 'SG_LB5_1.2.3', UpTime: 864000 });
      case 'sysbus.NeMo.Intf.veip0:getMIBs':
        return r({ gpon: { veip0: { SignalRxPower: st.rxPower, SignalTxPower: st.txPower } } });
      case 'sysbus.NeMo.Intf.veip0:getNetDevStats':
        return r({ RxBytes: st.rx, TxBytes: st.tx });
      case 'sysbus.NeMo.Intf.data:getMIBs':
        return r({ dhcp: { dhcp_data: { Uptime: st.wanUptime } } });
      case 'sysbus.AutoDiag:getDiagnosticsState':
        return r({ DiagnosticsState: st.diagRunning ? 'Requested' : (st.diagState || 'Complete'), Diagnostics: 'speedService' });
      case 'sysbus.AutoDiag:executeDiagnostics':
        st.diagRunning = true;
        st.pollsLeft = st.speedFail ? 0 : 2;
        return r(true);
      case 'sysbus.SpeedTest:getWANResults':
        if (st.diagRunning) {
          if (st.speedFail) { st.diagRunning = false; st.diagState = 'Error'; }
          else if (--st.pollsLeft <= 0) {
            st.diagRunning = false;
            st.speedResult = {
              status: 'Completed',
              Downstream: { start: `2026-10-25T10:${String(++st.runs).padStart(2, '0')}:00Z`, rate: 912345, latency: 4 },
              Upstream: { start: `2026-10-25T10:${String(st.runs).padStart(2, '0')}:00Z`, rate: 701234, latency: 5 },
            };
          }
        }
        return r(st.speedResult || { status: 'None' });
      default:
        return send({ result: { status: null, errors: [{ error: 196618, description: 'Object or parameter not found' }] } });
    }
  });
  return { server, st, start: () => listen(server) };
}

// ---------------------------------------------------------------- Deco
function fakeDeco({ password = 'owner-pass' } = {}) {
  const pwdKey = rsaKey(1024);
  const signKey = rsaKey(512);
  const seq = 1234;
  const st = { session: null, logins: 0, requests: [], expireNext: false, decos: null, clients: null };
  st.decos = [
    { mac: 'AA-BB-CC-00-00-01', role: 'master', nickname: 'living_room', custom_nickname: Buffer.from('Salon').toString('base64'), device_model: 'X50', device_ip: '192.168.68.1', group_status: 'connected', inet_status: 'online', connection_type: ['wired'], signal_level: {}, software_ver: '1.2.0' },
    { mac: 'AA-BB-CC-00-00-02', role: 'slave', nickname: 'office', custom_nickname: Buffer.from('Dépendance').toString('base64'), device_model: 'X50', device_ip: '192.168.68.2', group_status: 'connected', inet_status: 'online', connection_type: ['band5'], signal_level: { band2_4: '3', band5: '2' }, backhual_speed: 480, backhual_max_speed: 1200 },
  ];
  st.clients = {
    'AA-BB-CC-00-00-01': [
      { mac: '11-22-33-44-55-01', name: Buffer.from('Homey Pro').toString('base64'), ip: '192.168.68.10', online: true, connection_type: 'wired', interface: 'main', down_speed: 1000, up_speed: 500 },
      { mac: '11-22-33-44-55-02', name: Buffer.from("iPhone de Stéphane").toString('base64'), ip: '192.168.68.11', online: true, connection_type: 'band5', interface: 'main', down_speed: 20000, up_speed: 4000 },
    ],
    'AA-BB-CC-00-00-02': [
      { mac: '11-22-33-44-55-03', name: Buffer.from('Clim Dep').toString('base64'), ip: '192.168.68.12', online: true, connection_type: 'band2_4', interface: 'iot', down_speed: 0, up_speed: 0 },
    ],
  };
  const aes = (key, iv) => ({
    dec: (b64) => { const d = crypto.createDecipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv)); return Buffer.concat([d.update(Buffer.from(b64, 'base64')), d.final()]).toString('utf8'); },
    enc: (txt) => { const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv)); return Buffer.concat([c.update(txt, 'utf8'), c.final()]).toString('base64'); },
  });

  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    const url = new URL(req.url, 'http://x');
    const send = (o, extra = {}) => { res.writeHead(200, { 'Content-Type': 'application/json', ...extra }); res.end(JSON.stringify(o)); };
    const path = url.pathname.replace(/^\/cgi-bin\/luci\/;stok=[^/]*/, '');
    const form = url.searchParams.get('form');
    if (path === '/login' && form === 'keys') return send({ error_code: 0, result: { username: '', password: [pwdKey.n.toString(16), pwdKey.e.toString(16)] } });
    if (path === '/login' && form === 'auth') return send({ error_code: 0, result: { key: [signKey.n.toString(16), signKey.e.toString(16)], seq } });

    // Signed + encrypted request
    const params = new URLSearchParams(raw);
    const sign = rsaDecrypt(signKey, params.get('sign'));
    const sp = new URLSearchParams(sign);
    const data = params.get('data');
    const h = crypto.createHash('md5').update(`admin${password}`).digest('hex');
    if ((form !== 'login' && sp.get('h') !== h) || Number(sp.get('s')) !== seq + data.length) { res.writeHead(403); return res.end(); }
    const { enc, dec } = aes(sp.get('k'), sp.get('i'));
    const payload = JSON.parse(dec(data));

    if (path === '/login' && form === 'login') {
      st.logins++;
      if (rsaDecrypt(pwdKey, payload.params.password) !== password) {
        return send({ data: enc(JSON.stringify({ error_code: -5002, result: { attemptsAllowed: 9 } })) });
      }
      st.session = { stok: crypto.randomBytes(8).toString('hex'), cookie: crypto.randomBytes(8).toString('hex'), k: sp.get('k') };
      return send({ data: enc(JSON.stringify({ error_code: 0, result: { stok: st.session.stok } })) }, { 'Set-Cookie': `sysauth=${st.session.cookie}; path=/cgi-bin/luci` });
    }

    const stok = (/;stok=([^/]*)/.exec(url.pathname) || [])[1];
    if (!st.session || stok !== st.session.stok || !String(req.headers.cookie).includes(`sysauth=${st.session.cookie}`) || st.expireNext) {
      st.expireNext = false;
      return send({ data: '' });
    }
    st.requests.push(`${path}?${form}`);
    let result;
    if (path === '/admin/device' && form === 'device_list') result = { device_list: st.decos };
    else if (path === '/admin/network' && form === 'performance') result = { cpu_usage: 0.23, mem_usage: 0.61 };
    else if (path === '/admin/client' && form === 'client_list') {
      const mac = payload.params.device_mac;
      result = { client_list: mac === 'default' ? (st.globalOverride || Object.values(st.clients).flat()) : (st.clients[mac] || []) };
    } else return send({ data: enc(JSON.stringify({ error_code: -1 })) });
    return send({ data: enc(JSON.stringify({ error_code: 0, result })) });
  });
  return { server, st, start: () => listen(server) };
}

// ---------------------------------------------------------------- Cloudflare speed endpoints
function fakeSpeed({ downMbps = 80, upMbps = 40, delayMs = 5 } = {}) {
  const st = { down: 0, up: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__down') {
      const total = Number(url.searchParams.get('bytes')) || 0;
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': total, 'Server-Timing': 'cfRequestDuration;dur=1.0', 'cf-ray': '8abc-MRS' });
        if (!total) return res.end();
        // Throttle to the requested aggregate rate (shared by all streams)
        let sent = 0;
        const slice = Buffer.alloc(16384, 0x62);
        const tick = setInterval(() => {
          const n = Math.min(slice.length, total - sent);
          if (n <= 0 || res.destroyed) { clearInterval(tick); return res.end(); }
          sent += n; st.down += n;
          res.write(slice.subarray(0, n));
        }, (slice.length * 8) / (downMbps * 1e6 / 4) * 1000);
        res.on('close', () => clearInterval(tick));
      }, delayMs);
      return;
    }
    if (url.pathname === '/__up') {
      // Read at the target rate (TCP back-pressure throttles the client)
      const perStream = (upMbps * 1e6) / 4;
      req.on('data', (c) => { st.up += c.length; req.pause(); setTimeout(() => req.resume(), (c.length * 8 * 1000) / perStream); });
      req.on('end', () => { res.writeHead(200); res.end(); });
      return;
    }
    res.writeHead(404); res.end();
  });
  return { server, st, start: () => listen(server) };
}

// ---------------------------------------------------------------- Bbox (Bouygues)
function fakeBbox({ password = 'bbox-pass', requireAuth = false } = {}) {
  const st = { state: 'Up', ip: '89.1.2.3', rx: 5e9, tx: 1e9, logins: 0, requireAuth, session: null };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const send = (code, o, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...extra }); res.end(o == null ? '' : JSON.stringify(o)); };
    if (req.url === '/api/v1/login' && req.method === 'PUT') {
      st.logins++;
      const pw = new URLSearchParams(body).get('password');
      if (pw !== password) return send(401, [{ exception: { code: '401' } }]);
      st.session = 'BBOXSESSION';
      return send(200, null, { 'Set-Cookie': 'BBOX_ID=BBOXSESSION; Path=/; HttpOnly' });
    }
    if (st.requireAuth && !String(req.headers.cookie).includes(`BBOX_ID=${st.session}`)) return send(401, [{ exception: { code: '401' } }]);
    switch (req.url) {
      case '/api/v1/wan/ip': return send(200, [{ wan: { ip: { state: st.state, address: st.ip, mac: '00:11:22:33:44:55' }, link: { type: 'FTTH' } } }]);
      case '/api/v1/wan/ip/stats': return send(200, [{ wan: { ip: { stats: { rx: { bytes: String(st.rx) }, tx: { bytes: st.tx } } } } }]);
      case '/api/v1/device': return send(200, [{ device: { modelname: 'Bbox Ultym', main: { version: '23.7.12' }, uptime: 7200 } }]);
      default: return send(404, null);
    }
  });
  return { server, st, start: () => listen(server) };
}

// ---------------------------------------------------------------- SFR Box
function fakeSfr() {
  const st = { status: 'up', ip: '93.1.2.3' };
  const xml = (inner) => `<?xml version="1.0" encoding="UTF-8"?>\n<rsp stat="ok" version="1.0">\n  ${inner}\n</rsp>`;
  const server = http.createServer((req, res) => {
    const method = new URL(req.url, 'http://x').searchParams.get('method');
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    switch (method) {
      case 'wan.getInfo': return res.end(xml(`<wan status="${st.status}" uptime="86400" ip_addr="${st.ip}" infra="ftth" mode="ftth/routed" infra6="" status6="down" uptime6="" ipv6_addr="" />`));
      case 'system.getInfo': return res.end(xml('<system product_id="BOX10H-SER-r0" serial_number="X" mac_addr="6C:61:F4:00:00:00" net_mode="router" net_infra="ftth" uptime="5334" version_mainfirmware="BOX10H-XbSP-1.6.14.1" version_rescuefirmware="" version_bootloader="" version_dsldriver="" current_datetime="20251024160207" refclient="" idur="R" alimvoltage="0.000" temperature="48.5" />'));
      case 'ftth.getInfo': return res.end(xml('<ftth status="up" wanfibre="in"/>'));
      default: return res.end('<?xml version="1.0" ?><rsp stat="fail" version="1.0"><err code="115" msg="Authentication needed" /></rsp>');
    }
  });
  return { server, st, start: () => listen(server) };
}

module.exports = { fakeLivebox, fakeDeco, fakeSpeed, fakeBbox, fakeSfr, rsaDecrypt, rsaKey };
