'use strict';

const net = require('net');
const dns = require('dns');

/*
 * Connectivity probes. Homey apps cannot send ICMP, so latency is measured as the TCP
 * handshake time (SYN -> SYN/ACK), which tracks ICMP ping closely on a fibre line.
 */

/** TCP connect time to host:port in ms, or rejects. */
function tcpConnectTime(host, port, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const sock = net.connect({ host, port });
    const done = (err) => {
      sock.removeAllListeners();
      sock.destroy();
      if (err) reject(err);
      else resolve(Number(process.hrtime.bigint() - start) / 1e6);
    };
    sock.setTimeout(timeout, () => done(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    sock.once('connect', () => done());
    sock.once('error', done);
  });
}

/** Parses "1.1.1.1:443, dns.google:443" into [{host, port}]. */
function parseTargets(text, defaultPort = 443) {
  return String(text || '')
    .split(/[,;\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(t);
      return { host: m[1], port: m[2] ? Number(m[2]) : defaultPort };
    });
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Mean absolute difference between consecutive samples (RFC 3550 style jitter estimate). */
function jitter(values) {
  if (values.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < values.length; i++) sum += Math.abs(values[i] - values[i - 1]);
  return sum / (values.length - 1);
}

/**
 * One probe round: `samples` connections to each target, sequential to avoid self-induced jitter.
 * @returns {Promise<{online:boolean, latency:number|null, jitter:number|null, loss:number, reachable:number, total:number, perTarget:object[]}>}
 */
async function probeRound(targets, { samples = 3, timeout = 3000, connect = tcpConnectTime } = {}) {
  const all = [];
  const perTarget = [];
  let attempts = 0;
  let failures = 0;
  for (const t of targets) {
    const times = [];
    let lastError = null;
    for (let i = 0; i < samples; i++) {
      attempts++;
      try {
        times.push(await connect(t.host, t.port, timeout));
      } catch (e) {
        failures++;
        lastError = e.code || e.message;
      }
    }
    perTarget.push({ target: `${t.host}:${t.port}`, ok: times.length > 0, latency: median(times), error: times.length ? null : lastError });
    all.push(...times);
  }
  const reachable = perTarget.filter((p) => p.ok).length;
  const best = perTarget.filter((p) => p.ok).map((p) => p.latency);
  return {
    online: reachable > 0,
    // Median of the per-target medians: robust to one slow anycast node
    latency: best.length ? median(best) : null,
    jitter: all.length > 1 ? jitter(all) : null,
    loss: attempts ? (failures / attempts) * 100 : 100,
    reachable,
    total: targets.length,
    perTarget,
  };
}

/** DNS resolution time in ms (system resolver, i.e. the Livebox), or rejects. */
function dnsTime(hostname = 'www.google.com', timeout = 3000) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    let finished = false;
    const timer = setTimeout(() => {
      finished = true;
      reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    }, timeout);
    // Goes through the system resolver (the Livebox): checks that name resolution works end to end
    dns.lookup(hostname, (err) => {
      if (finished) return;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(Number(process.hrtime.bigint() - start) / 1e6);
    });
  });
}

module.exports = { tcpConnectTime, parseTargets, probeRound, dnsTime, median, jitter };
