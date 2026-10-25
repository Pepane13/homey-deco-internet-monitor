'use strict';

const crypto = require('crypto');
const { request, parseCookies, cookieHeader } = require('./http');

/*
 * Local client for TP-Link Deco mesh systems (LuCI JSON API of the main Deco).
 * Protocol (same as the Deco web UI): RSA PKCS#1 v1.5 for the password and the request signature,
 * AES-128-CBC for every payload, sysauth cookie + stok token for the session.
 * Read-only: devices, clients and performance are read; nothing is ever written to the Deco.
 */

class DecoError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// ---------- RSA PKCS#1 v1.5 encryption with raw (n, e), dependency-free (BigInt) ----------

function modPow(base, exp, mod) {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}

function nonZeroRandom(len) {
  const out = Buffer.alloc(len);
  let i = 0;
  while (i < len) {
    const chunk = crypto.randomBytes(len);
    for (const b of chunk) if (b !== 0 && i < len) out[i++] = b;
  }
  return out;
}

/** Encrypts `plaintext` in blocks of (k - 11) bytes and concatenates the hex ciphertexts (TP-Link scheme). */
function rsaEncrypt(nHex, eHex, plaintext) {
  const n = BigInt(`0x${nHex}`);
  const e = BigInt(`0x${eHex}`);
  const k = Math.ceil(n.toString(16).length / 2);
  const max = k - 11;
  const data = Buffer.from(plaintext, 'utf8');
  let out = '';
  for (let i = 0; i < data.length; i += max) {
    const m = data.subarray(i, i + max);
    const block = Buffer.concat([Buffer.from([0, 2]), nonZeroRandom(k - 3 - m.length), Buffer.from([0]), m]);
    const c = modPow(BigInt(`0x${block.toString('hex')}`), e, n);
    out += c.toString(16).padStart(k * 2, '0');
  }
  return out;
}

// ---------- AES-128-CBC, PKCS#7 padding ----------

function aesEncrypt(key, iv, text) {
  const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv));
  return Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('base64');
}

function aesDecrypt(key, iv, b64) {
  const d = crypto.createDecipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv));
  return Buffer.concat([d.update(Buffer.from(b64, 'base64')), d.final()]).toString('utf8');
}

/** 16-digit decimal string without leading zero (format required by the Deco). */
function randomDigits16() {
  let s = String(1 + crypto.randomInt(9));
  while (s.length < 16) s += String(crypto.randomInt(10));
  return s;
}

function decodeName(name) {
  if (!name || typeof name !== 'string') return name || '';
  try {
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(name) && name.length % 4 === 0) {
      const txt = Buffer.from(name, 'base64').toString('utf8');
      if (txt && !/[\u0000-\u0008�]/.test(txt)) return txt;
    }
  } catch (e) { /* not base64 */ }
  return name;
}

function normMac(mac) {
  return String(mac || '').toUpperCase().replace(/-/g, ':');
}

class DecoClient {
  constructor({ host, password, username = 'admin', timeout = 15000 }) {
    host = String(host || '').trim().replace(/,/g, '.'); // device settings typed with a French keyboard
    this.base = /^https?:\/\//.test(host) ? host.replace(/\/+$/, '') : `http://${host}`;
    this.username = username || 'admin';
    this.password = password || '';
    this.timeout = timeout;
    this._reset();
    this._queue = Promise.resolve();
  }

  _reset() {
    this.aesKey = null;
    this.aesIv = null;
    this.pwdKey = null; // [n, e]
    this.signKey = null; // [n, e]
    this.seq = null;
    this.stok = null;
    this.cookies = {};
  }

  /** Serialises calls: the Deco only accepts one session for the owner account. */
  _serial(fn) {
    const p = this._queue.then(fn, fn);
    this._queue = p.catch(() => {});
    return p;
  }

  async _postJson(path, form, body, extraHeaders = {}) {
    const res = await request(`${this.base}/cgi-bin/luci/;stok=${this.stok || ''}${path}?form=${form}`, {
      method: 'POST',
      body,
      timeout: this.timeout,
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
    });
    if (res.url.startsWith('https:') && this.base.startsWith('http:')) this.base = `https:${this.base.slice(5)}`;
    Object.assign(this.cookies, parseCookies(res.headers));
    if (res.status === 401 || res.status === 403) {
      throw new DecoError(`HTTP ${res.status} on ${path}`, res.status === 403 ? 'EFORBIDDEN' : 'EUNSUPPORTED');
    }
    if (res.status >= 400) throw new DecoError(`HTTP ${res.status} on ${path}`, 'EHTTP');
    try {
      return JSON.parse(res.body.toString('utf8'));
    } catch (e) {
      throw new DecoError(`Invalid JSON on ${path}`, 'EPROTO');
    }
  }

  _encode(payload) {
    const data = aesEncrypt(this.aesKey, this.aesIv, JSON.stringify(payload));
    const hash = crypto.createHash('md5').update(`${this.username}${this.password}`).digest('hex');
    const signText = `k=${this.aesKey}&i=${this.aesIv}&h=${hash}&s=${this.seq + data.length}`;
    const sign = rsaEncrypt(this.signKey[0], this.signKey[1], signText);
    return `sign=${sign}&data=${encodeURIComponent(data)}`;
  }

  _decode(data) {
    if (data && typeof data === 'object') return data;
    if (!data) throw new DecoError('Empty response (session expired)', 'ESESSION');
    return JSON.parse(aesDecrypt(this.aesKey, this.aesIv, data));
  }

  async login() {
    this._reset();
    this.aesKey = randomDigits16();
    this.aesIv = randomDigits16();

    let keys;
    try {
      keys = await this._postJson('/login', 'keys', JSON.stringify({ operation: 'read' }));
    } catch (e) {
      if (e.code === 'EUNSUPPORTED') {
        throw new DecoError('This Deco firmware uses the legacy web-session protocol, not supported yet', 'EUNSUPPORTED');
      }
      throw e;
    }
    this.pwdKey = keys.result.password;
    const auth = await this._postJson('/login', 'auth', JSON.stringify({ operation: 'read' }));
    this.signKey = auth.result.key;
    this.seq = Number(auth.result.seq);

    const body = this._encode({
      params: { password: rsaEncrypt(this.pwdKey[0], this.pwdKey[1], this.password) },
      operation: 'login',
    });
    let res;
    try {
      res = await this._postJson('/login', 'login', body);
    } catch (e) {
      if (e.code === 'EFORBIDDEN') throw new DecoError('Login forbidden (owner account in use elsewhere?)', 'EAUTH');
      throw e;
    }
    const data = this._decode(res.data);
    if (data.error_code !== 0) {
      this._reset();
      const left = data.result && data.result.attemptsAllowed;
      throw new DecoError(`Login refused (error ${data.error_code}${left != null ? `, ${left} attempts left` : ''})`, 'EAUTH');
    }
    this.stok = data.result.stok;
    if (!this.cookies.sysauth) throw new DecoError('Login response without session cookie', 'EPROTO');
  }

  async _call(path, form, payload) {
    const res = await this._postJson(path, form, this._encode(payload), { Cookie: cookieHeader(this.cookies) });
    const data = this._decode(res.data);
    const code = data.error_code != null ? data.error_code : data.errorcode;
    if (code && code !== 0) throw new DecoError(`${path}?form=${form} error ${code}`, code === 'timeout' ? 'ETIMEDOUT' : 'EAPI');
    return data.result || {};
  }

  /** Authenticated call with one transparent re-login on session errors. */
  call(path, form, payload) {
    return this._serial(async () => {
      if (!this.stok) await this.login();
      try {
        return await this._call(path, form, payload);
      } catch (e) {
        if (['ESESSION', 'EFORBIDDEN', 'EUNSUPPORTED'].includes(e.code) || e instanceof SyntaxError || /bad decrypt/i.test(e.message)) {
          await this.login();
          return this._call(path, form, payload);
        }
        throw e;
      }
    });
  }

  async listDecos() {
    const r = await this.call('/admin/device', 'device_list', { operation: 'read' });
    return (r.device_list || []).map((d) => {
      const signal = d.signal_level || {};
      const lvl = (x) => (x == null || x === '' ? null : Number(x));
      return {
        mac: normMac(d.mac),
        rawMac: d.mac,
        name: decodeName(d.custom_nickname) || d.nickname || d.device_model || normMac(d.mac),
        model: d.device_model || null,
        hardware: d.hardware_ver || null,
        firmware: d.software_ver || null,
        ip: d.device_ip || null,
        master: d.role === 'master',
        online: d.group_status === 'connected',
        internet: d.inet_status == null ? null : ['online', 'connected', 'up'].includes(String(d.inet_status).toLowerCase()),
        backhaul: Array.isArray(d.connection_type) ? d.connection_type.join('+') : (d.connection_type || null),
        signal24: lvl(signal.band2_4),
        signal5: lvl(signal.band5),
        backhaulSpeed: d.backhual_speed != null ? Number(d.backhual_speed) : null,
        backhaulMaxSpeed: d.backhual_max_speed != null ? Number(d.backhual_max_speed) : null,
      };
    });
  }

  async listClients(decoMac = 'default') {
    const r = await this.call('/admin/client', 'client_list', { operation: 'read', params: { device_mac: decoMac } });
    return (r.client_list || []).map((c) => ({
      mac: normMac(c.mac),
      name: decodeName(c.name) || normMac(c.mac),
      ip: c.ip || null,
      online: c.online !== false,
      band: c.connection_type || null, // band2_4 | band5 | band6 | wired
      network: c.interface || 'main', // main | guest | iot
      // Current client rates in kbit/s (ha-tplink-deco divides them by 8 to report kB/s);
      // other field names seen on some firmwares are accepted as well
      down: Number(c.down_speed ?? c.downSpeed ?? c.down_rate ?? c.rx_rate) || 0,
      up: Number(c.up_speed ?? c.upSpeed ?? c.up_rate ?? c.tx_rate) || 0,
      fields: Object.keys(c),
    }));
  }

  async getPerformance() {
    const r = await this.call('/admin/network', 'performance', { operation: 'read' });
    const pct = (x) => {
      const v = Number(x);
      if (!Number.isFinite(v)) return null;
      return v <= 1 ? Math.round(v * 1000) / 10 : Math.round(v * 10) / 10;
    };
    return { cpu: pct(r.cpu_usage), mem: pct(r.mem_usage) };
  }

  /** Clients per Deco, keyed by Deco MAC (one request per Deco). */
  async listClientsByDeco(decos) {
    const out = {};
    for (const d of decos) {
      if (!d.online) { out[d.mac] = []; continue; }
      try {
        out[d.mac] = await this.listClients(d.rawMac || d.mac);
      } catch (e) {
        out[d.mac] = null;
      }
    }

    // Some firmwares only fill the client rates in the global list ("default"): copy them by MAC
    const perNode = Object.values(out).filter(Array.isArray).flat();
    const withTraffic = (list) => list.filter((c) => c.down > 0 || c.up > 0).length;
    let global = [];
    try { global = await this.listClients('default'); } catch (e) { /* optional */ }
    const rates = new Map(global.map((c) => [c.mac, c]));
    let copied = 0;
    for (const c of perNode) {
      const g = rates.get(c.mac);
      if (g && c.down === 0 && c.up === 0 && (g.down > 0 || g.up > 0)) {
        c.down = g.down;
        c.up = g.up;
        copied++;
      }
    }
    const fields = [...new Set([...perNode, ...global].flatMap((c) => c.fields || []))].sort();
    Object.defineProperty(out, 'diag', {
      enumerable: false,
      value: {
        clients: perNode.length,
        perNodeWithTraffic: withTraffic(perNode) - copied,
        globalClients: global.length,
        globalWithTraffic: withTraffic(global),
        copied,
        fields,
      },
    });
    return out;
  }
}

module.exports = { DecoClient, DecoError, _internals: { rsaEncrypt, aesEncrypt, aesDecrypt, decodeName, modPow } };
