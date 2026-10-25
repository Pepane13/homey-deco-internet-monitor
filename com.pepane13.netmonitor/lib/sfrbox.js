'use strict';

const crypto = require('crypto');
const { request } = require('./http');

/*
 * Local client for SFR boxes (neufbox family: NB6V/NB6VAC, SFR Box 8, SFR Box 8X, Box 10...):
 * XML API http://<box>/api/1.0/?method=<namespace>.<method>.
 * wan.getInfo, system.getInfo and ftth.getInfo are public on the LAN: no password is needed for
 * monitoring. The password is only used (token + HMAC-SHA256) if a firmware requires it.
 * The public API exposes neither traffic counters nor optical power.
 */

class SfrError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** Attributes of the first <tag .../> element of an XML string. */
function attrs(xml, tag) {
  const m = new RegExp(`<${tag}\\b([^>]*?)/?>`).exec(xml);
  if (!m) return null;
  const out = {};
  const re = /([\w:-]+)="([^"]*)"/g;
  let a;
  while ((a = re.exec(m[1]))) out[a[1]] = a[2];
  return out;
}

const hmacHash = (token, value) => crypto.createHmac('sha256', token)
  .update(crypto.createHash('sha256').update(value).digest('hex')).digest('hex');

class SfrClient {
  constructor({ host = '192.168.1.1', username = 'admin', password = '', timeout = 10000 }) {
    host = String(host || '').trim().replace(/,/g, '.');
    this.base = /^https?:\/\//.test(host) ? host.replace(/\/+$/, '') : `http://${host}`;
    this.username = username || 'admin';
    this.password = password || '';
    this.timeout = timeout;
    this.token = null;
  }

  async _get(method, params = {}) {
    const qs = new URLSearchParams({ method, ...params }).toString();
    const res = await request(`${this.base}/api/1.0/?${qs}`, { timeout: this.timeout });
    if (res.status >= 400) throw new SfrError(`${method}: HTTP ${res.status}`, 'EHTTP');
    let xml = res.body.toString('utf8');
    if (xml.includes('</firewall>') && xml.includes('<dsl')) xml = xml.replace('</firewall>', '/>'); // firmware 3DCM020200r015 bug
    const rsp = attrs(xml, 'rsp');
    if (!rsp) throw new SfrError(`${method}: not an SFR Box API answer`, 'EPROTO');
    if (rsp.stat !== 'ok') {
      const err = attrs(xml, 'err') || {};
      const auth = ['115', '204', '901'].includes(err.code);
      if (auth) this.token = null;
      throw new SfrError(`${method}: [${err.code || '?'}] ${err.msg || 'failed'}`, auth ? 'EAUTH' : 'EAPI');
    }
    return xml;
  }

  async _token() {
    if (this.token) return this.token;
    if (!this.password) throw new SfrError('The SFR Box asks for its administration password', 'EAUTH');
    const t = attrs(await this._get('auth.getToken'), 'auth') || {};
    if (!['all', 'passwd'].includes(t.method)) throw new SfrError(`Password login disabled on the box (${t.method})`, 'EAUTH');
    const hash = hmacHash(t.token, this.username) + hmacHash(t.token, this.password);
    const ok = attrs(await this._get('auth.checkToken', { token: t.token, hash }), 'auth') || {};
    this.token = ok.token;
    return this.token;
  }

  /** Public call, retried once with a token if this firmware requires authentication. */
  async call(method, tag) {
    try {
      return attrs(await this._get(method), tag);
    } catch (e) {
      if (e.code !== 'EAUTH' || !this.password) throw e;
      return attrs(await this._get(method, { token: await this._token() }), tag);
    }
  }

  async readCounters() {
    return null; // not exposed by the SFR Box API
  }

  async getStatus() {
    const wan = (await this.call('wan.getInfo', 'wan')) || {};
    const sys = await this.call('system.getInfo', 'system').catch(() => null) || {};
    const ftth = await this.call('ftth.getInfo', 'ftth').catch(() => null);
    const num = (x) => (x === '' || x == null || !Number.isFinite(Number(x)) ? null : Number(x));
    let temperature = num(sys.temperature);
    if (temperature != null && temperature > 1000) temperature /= 1000; // millidegrees on older firmwares
    return {
      online: wan.status === 'up',
      linkType: wan.infra || sys.net_infra || null,
      gponState: ftth ? `${ftth.status || '?'}` : null,
      connectionState: wan.status || null,
      lastError: null,
      publicIp: wan.ip_addr || null,
      model: sys.product_id || 'SFR Box',
      firmware: sys.version_mainfirmware || null,
      boxUptime: num(sys.uptime),
      wanUptime: num(wan.uptime),
      rxPower: null,
      txPower: null,
      temperature,
      stateText: `${wan.status || 'unknown'}${wan.infra ? ` · ${String(wan.infra).toUpperCase()}` : ''}${ftth ? ` · fibre ${ftth.status}` : ''}`,
    };
  }
}

module.exports = { SfrClient, SfrError, _internals: { attrs, hmacHash } };
