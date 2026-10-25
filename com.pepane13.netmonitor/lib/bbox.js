'use strict';

const { request, parseCookies, cookieHeader } = require('./http');

/*
 * Local client for Bouygues Telecom Bbox (Bbox Fibre, Bbox Ultym, Bbox Wi-Fi 6/7...): REST API
 * /api/v1 served by the box (https://mabbox.bytel.fr = 192.168.1.254 on the LAN, self-signed).
 * Read-only. Most status endpoints answer from the LAN without login; the admin password is
 * used only when the box asks for it (HTTP 401), with the BBOX_ID session cookie.
 * Each failed login extends the Bbox lockout, so a refused password is never retried in a loop.
 */

class BboxError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const num = (x) => {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
};

/** Bbox answers `[{"<key>": {...}}]` almost everywhere. */
function first(json) {
  if (Array.isArray(json)) return json[0] || {};
  return json || {};
}

class BboxClient {
  constructor({ host = '192.168.1.254', password = '', timeout = 10000 }) {
    host = String(host || '').trim().replace(/,/g, '.');
    this.base = /^https?:\/\//.test(host) ? host.replace(/\/+$/, '') : `https://${host}`;
    this.password = password || '';
    this.timeout = timeout;
    this.cookies = {};
    this.authFailed = false;
    this.counterWrap = 2 ** 64;
  }

  _headers(extra = {}) {
    return {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: this.base,
      Referer: `${this.base}/login`,
      ...(Object.keys(this.cookies).length ? { Cookie: cookieHeader(this.cookies) } : {}),
      ...extra,
    };
  }

  async _req(method, path, body, ctype) {
    try {
      return await request(`${this.base}${path}`, {
        method, body, timeout: this.timeout, headers: this._headers(ctype ? { 'Content-Type': ctype } : {}),
      });
    } catch (e) {
      // Some firmwares serve plain HTTP only: switch once
      if (this.base.startsWith('https:') && ['ECONNREFUSED', 'EPROTO', 'ECONNRESET'].includes(e.code)) {
        this.base = `http:${this.base.slice(6)}`;
        return request(`${this.base}${path}`, { method, body, timeout: this.timeout, headers: this._headers(ctype ? { 'Content-Type': ctype } : {}) });
      }
      throw e;
    }
  }

  async login() {
    if (!this.password) throw new BboxError('The Bbox asks for its administration password', 'EAUTH');
    if (this.authFailed) throw new BboxError('Bbox password refused (not retried to avoid the lockout)', 'EAUTH');
    const body = `password=${encodeURIComponent(this.password)}&remember=1`;
    // Recent firmwares use PUT, older ones POST (documented API)
    let res = await this._req('PUT', '/api/v1/login', body, 'application/x-www-form-urlencoded; charset=UTF-8');
    if (res.status === 404 || res.status === 405) res = await this._req('POST', '/api/v1/login', body, 'application/x-www-form-urlencoded; charset=UTF-8');
    Object.assign(this.cookies, parseCookies(res.headers));
    if (res.status === 429) throw new BboxError('Bbox login rate-limited: wait 15 minutes', 'ELOCKED');
    if (res.status === 401 || res.status === 403) {
      this.authFailed = true;
      throw new BboxError('Bbox password refused', 'EAUTH');
    }
    if (res.status >= 400) throw new BboxError(`Bbox login failed (HTTP ${res.status})`, 'EHTTP');
  }

  async get(path) {
    let res = await this._req('GET', path);
    if (res.status === 401) {
      await this.login();
      res = await this._req('GET', path);
    }
    if (res.status === 401) throw new BboxError(`${path}: authentication required`, 'EAUTH');
    if (res.status >= 400) throw new BboxError(`${path}: HTTP ${res.status}`, 'EHTTP');
    try {
      return first(JSON.parse(res.body.toString('utf8')));
    } catch (e) {
      throw new BboxError(`${path}: invalid JSON`, 'EPROTO');
    }
  }

  async readCounters() {
    const s = await this.get('/api/v1/wan/ip/stats');
    const st = (((s.wan || {}).ip || {}).stats) || s;
    const bytes = (d) => num((st[d] || {}).bytes ?? st[`${d}bytes`]);
    return { rx: bytes('rx'), tx: bytes('tx') };
  }

  async getStatus() {
    const wan = (await this.get('/api/v1/wan/ip')).wan || {};
    const ip = wan.ip || {};
    let dev = {};
    try { dev = (await this.get('/api/v1/device')).device || {}; } catch (e) { /* optional */ }
    const state = String(ip.state || wan.internet?.state || '').toLowerCase();
    return {
      online: state === 'up' || state === '2' || wan.internet?.state === 2,
      linkType: wan.link?.type || null,
      gponState: null,
      connectionState: ip.state || null,
      lastError: null,
      publicIp: ip.address || null,
      model: dev.modelname || 'Bbox',
      firmware: (dev.main && dev.main.version) || dev.firmware || null,
      boxUptime: num(dev.uptime),
      wanUptime: num(ip.uptime ?? wan.uptime),
      rxPower: null,
      txPower: null,
      stateText: `${ip.state || 'unknown'}${wan.link?.type ? ` · ${String(wan.link.type).toUpperCase()}` : ''}`,
    };
  }
}

module.exports = { BboxClient, BboxError };
