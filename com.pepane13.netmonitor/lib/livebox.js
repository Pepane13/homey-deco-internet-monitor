'use strict';

const { request, parseCookies, cookieHeader } = require('./http');

const APP_NAME = 'so_sdkut';

class LiveboxError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * Local client for the Orange Livebox 5 (Sagemcom "sysbus" JSON API on http://<host>/ws).
 * Read-only: only status methods are called.
 */
class LiveboxClient {
  constructor({ host, username = 'admin', password, timeout = 10000 }) {
    host = String(host || '').trim().replace(/,/g, '.'); // device settings typed with a French keyboard
    this.base = /^https?:\/\//.test(host) ? host.replace(/\/+$/, '') : `http://${host}`;
    this.username = username || 'admin';
    this.password = password || '';
    this.timeout = timeout;
    this.contextId = null;
    this.cookies = {};
    this.ontKey = null;
    this.counterWrap = 2 ** 32;
  }

  async login() {
    const body = JSON.stringify({
      service: 'sah.Device.Information',
      method: 'createContext',
      parameters: { applicationName: APP_NAME, username: this.username, password: this.password },
    });
    const res = await request(`${this.base}/ws`, {
      method: 'POST',
      body,
      timeout: this.timeout,
      headers: {
        Accept: '*/*',
        Authorization: 'X-Sah-Login',
        'Content-Type': 'application/x-sah-ws-4-call+json',
      },
    });
    let json;
    try { json = JSON.parse(res.body.toString('utf8')); } catch (e) {
      throw new LiveboxError(`Unexpected login response (HTTP ${res.status})`, 'EPROTO');
    }
    const contextId = json && json.data && json.data.contextID;
    if (!contextId) {
      const err = (json.errors && json.errors[0]) || {};
      throw new LiveboxError(`Login refused${err.description ? `: ${err.description}` : ''}`, 'EAUTH');
    }
    this.contextId = contextId;
    this.cookies = parseCookies(res.headers);
  }

  async _post(service, method, parameters) {
    const res = await request(`${this.base}/ws`, {
      method: 'POST',
      timeout: this.timeout,
      body: JSON.stringify({ service: `sysbus.${service}`, method, parameters: parameters || {} }),
      headers: {
        Accept: '*/*',
        Authorization: `X-Sah ${this.contextId}`,
        'X-Context': this.contextId,
        'Content-Type': 'application/x-sah-ws-4-call+json; charset=UTF-8',
        Cookie: cookieHeader(this.cookies),
      },
    });
    let json;
    try { json = JSON.parse(res.body.toString('utf8')); } catch (e) {
      throw new LiveboxError(`${service}:${method} invalid JSON (HTTP ${res.status})`, 'EPROTO');
    }
    if (json && json.result) json = json.result;
    return json;
  }

  /** Calls a sysbus method, logging in (again) when needed. Returns the reply ({status, data}). */
  async call(service, method, parameters) {
    if (!this.contextId) await this.login();
    let reply = await this._post(service, method, parameters);
    if (LiveboxClient._isAuthError(reply)) {
      await this.login();
      reply = await this._post(service, method, parameters);
    }
    if (reply && Array.isArray(reply.errors) && reply.errors.length) {
      const e = reply.errors[0];
      throw new LiveboxError(`${service}:${method} ${e.description || 'error'}${e.info ? ` (${e.info})` : ''}`, 'EAPI');
    }
    return reply || {};
  }

  static _isAuthError(reply) {
    // error 13 = "Permission denied" (expired or missing context)
    return !!(reply && Array.isArray(reply.errors) && reply.errors.some((e) => e.error === 13 || /permission/i.test(e.description || '')));
  }

  /** WAN traffic counters (32-bit on the Livebox: read them often). */
  async readCounters() {
    const ont = await this._findOntKey();
    const s = (await this.call(`NeMo.Intf.${ont}`, 'getNetDevStats')).status || {};
    return { rx: typeof s.RxBytes === 'number' ? s.RxBytes : null, tx: typeof s.TxBytes === 'number' ? s.TxBytes : null };
  }

  async _findOntKey() {
    if (this.ontKey) return this.ontKey;
    try {
      const r = await this.call('HomeLan.Interface', 'get');
      const list = r.status || {};
      const key = Object.keys(list).find((k) => ['WAN_GPON', 'WAN_XGSPON'].includes((list[k] || {}).FriendlyName));
      this.ontKey = key || 'veip0';
    } catch (e) {
      this.ontKey = 'veip0';
    }
    return this.ontKey;
  }

  /**
   * Native Livebox speed test (AutoDiag "speedService", same as the Livebox web interface).
   * Measured by the box itself towards Orange servers, so it is not limited by the LAN.
   * Rates are returned by the box in kbit/s, latency in ms.
   */
  async runSpeedtest({ timeoutS = 150, pollS = 5, sleep } = {}) {
    const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const results = async () => {
      const r = await this.call('SpeedTest', 'getWANResults');
      return r.status || {};
    };
    const before = await results().catch(() => ({}));
    const prevStart = before.Downstream && before.Downstream.start;

    const state = await this.call('AutoDiag', 'getDiagnosticsState');
    if (((state.status || {}).DiagnosticsState) === 'Requested') {
      throw new LiveboxError('A Livebox diagnostic is already running', 'EBUSY');
    }
    await this.call('AutoDiag', 'executeDiagnostics', { id: 'speedService', usr: true });

    const deadline = Date.now() + timeoutS * 1000;
    let idleRounds = 0;
    while (Date.now() < deadline) {
      await wait(pollS * 1000);
      const r = await results().catch(() => ({}));
      if (r.status === 'Completed' && r.Downstream && r.Upstream && r.Downstream.start !== prevStart) {
        const kbit = (x) => Math.round((Number(x) || 0) / 100) / 10;
        return {
          download: kbit(r.Downstream.rate),
          upload: kbit(r.Upstream.rate),
          latency: Number(r.Downstream.latency) || null,
          jitter: null,
          server: 'Livebox',
          source: 'livebox',
        };
      }
      // Diagnostic over without new results: failed (no need to wait for the timeout)
      const st = await this.call('AutoDiag', 'getDiagnosticsState').catch(() => ({}));
      if (((st.status || {}).DiagnosticsState) !== 'Requested' && ++idleRounds >= 3) {
        throw new LiveboxError(`Livebox speed test ended without results (${(st.status || {}).DiagnosticsState || 'unknown'})`, 'EFAILED');
      }
    }
    throw new LiveboxError('Livebox speed test timed out', 'ETIMEDOUT');
  }

  /**
   * Full snapshot. Only the WAN status is mandatory; the other parts are best-effort.
   * @returns {Promise<object>} normalised status
   */
  async getStatus() {
    const wanReply = await this.call('NMC', 'getWANStatus');
    const wan = wanReply.data || {};
    const ont = await this._findOntKey();

    const [info, gpon, stats, dhcp] = await Promise.allSettled([
      this.call('DeviceInfo', 'get'),
      this.call(`NeMo.Intf.${ont}`, 'getMIBs', { mibs: 'gpon' }),
      this.call(`NeMo.Intf.${ont}`, 'getNetDevStats'),
      this.call('NeMo.Intf.data', 'getMIBs', { mibs: 'dhcp' }),
    ]);
    const v = (p) => (p.status === 'fulfilled' ? p.value.status : null);

    const dev = v(info) || {};
    const g = ((v(gpon) || {}).gpon || {})[ont] || {};
    const s = v(stats) || {};
    const dh = (((v(dhcp) || {}).dhcp || {}).dhcp_data) || {};

    const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    return {
      online: String(wan.LinkState).toLowerCase() === 'up'
        && ['bound', 'connected', 'up'].includes(String(wan.ConnectionState).toLowerCase()),
      linkState: wan.LinkState || null,
      wanState: wan.WanState || null,
      connectionState: wan.ConnectionState || null,
      linkType: wan.LinkType || null,
      gponState: wan.GponState || null,
      lastError: wan.LastConnectionError || null,
      publicIp: wan.IPAddress || null,
      ipv6: wan.IPv6Address || null,
      model: dev.ModelName || dev.ProductClass || null,
      firmware: dev.SoftwareVersion || null,
      boxUptime: num(dev.UpTime),
      wanUptime: num(dh.Uptime),
      rxPower: num(g.SignalRxPower) != null ? g.SignalRxPower / 1000 : null,
      txPower: num(g.SignalTxPower) != null ? g.SignalTxPower / 1000 : null,
      rxBytes: num(s.RxBytes),
      txBytes: num(s.TxBytes),
      ontInterface: ont,
      stateText: [wan.GponState, wan.LinkType && String(wan.LinkType).toUpperCase()].filter(Boolean).join(' · ') || null,
    };
  }
}


module.exports = { LiveboxClient, LiveboxError };
