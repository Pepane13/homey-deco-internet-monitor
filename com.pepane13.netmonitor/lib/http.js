'use strict';

const http = require('http');
const https = require('https');

/** True for RFC 1918 / link-local / loopback IPv4 addresses (local LAN equipment). */
function isPrivateHost(hostname) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname || '');
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/**
 * Minimal dependency-free HTTP(S) client.
 * Self-signed certificates are accepted only for private LAN addresses (routers use them);
 * certificate validation is never relaxed for Internet hosts.
 * @returns {Promise<{status:number, headers:object, body:Buffer, url:string}>}
 */
function request(url, { method = 'GET', headers = {}, body = null, timeout = 10000, maxRedirects = 2 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || undefined,
      path: `${u.pathname}${u.search}`,
      headers: { ...headers },
      timeout,
    };
    if (u.protocol === 'https:' && isPrivateHost(u.hostname)) opts.rejectUnauthorized = false;
    if (body != null && opts.headers['Content-Length'] == null) opts.headers['Content-Length'] = Buffer.byteLength(body);

    const req = lib.request(opts, (res) => {
      // Same-host redirects only (e.g. Deco firmwares redirecting http:// to https://)
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url);
        if (next.hostname !== u.hostname) {
          reject(Object.assign(new Error(`Redirect to another host refused: ${next.hostname}`), { code: 'EREDIRECT' }));
          return;
        }
        request(next.toString(), { method, headers, body, timeout, maxRedirects: maxRedirects - 1 }).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), url }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error(`Timeout after ${timeout} ms`), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

/** Extracts "name=value" pairs from Set-Cookie headers. */
function parseCookies(headers) {
  const raw = headers['set-cookie'] || [];
  const out = {};
  for (const line of Array.isArray(raw) ? raw : [raw]) {
    const pair = String(line).split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

function cookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

module.exports = { request, parseCookies, cookieHeader, isPrivateHost };
