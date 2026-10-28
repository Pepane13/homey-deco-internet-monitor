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

/**
 * Round-trip time to a LAN device in ms: TCP SYN answered by SYN/ACK (port open) or by RST
 * (port closed, ECONNREFUSED) both measure the network path. Rejects only on timeout or no route.
 */
function tcpRtt(host, port, timeout = 1000) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const sock = net.connect({ host, port });
    const elapsed = () => Number(process.hrtime.bigint() - start) / 1e6;
    const done = (err) => {
      sock.removeAllListeners();
      sock.destroy();
      if (!err || err.code === 'ECONNREFUSED') resolve(elapsed());
      else reject(err);
    };
    sock.setTimeout(timeout, () => done(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    sock.once('connect', () => done());
    sock.once('error', done);
  });
}

/** `samples` sequential RTT measurements: median, jitter and loss. */
async function rttSeries(host, port, { samples = 5, timeout = 1000, rtt = tcpRtt } = {}) {
  const times = [];
  let lastError = null;
  for (let i = 0; i < samples; i++) {
    try {
      times.push(await rtt(host, port, timeout));
    } catch (e) {
      lastError = e.code || e.message;
    }
  }
  return {
    latency: median(times),
    jitter: times.length > 1 ? jitter(times) : null,
    loss: ((samples - times.length) / samples) * 100,
    max: times.length ? Math.max(...times) : null,
    error: times.length ? null : lastError,
  };
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
 * Jitter robust to one isolated slow sample: with 3 samples or more, the slowest one is left out
 * (a single delayed connection is a hiccup, not jitter), then the RFC 3550 style estimate is used.
 * Jitter that affects several samples of the series is still reported.
 */
function trimmedJitter(values) {
  if (values.length < 3) return jitter(values);
  const drop = values.indexOf(Math.max(...values));
  return jitter(values.filter((_, i) => i !== drop));
}

/**
 * One probe round: `samples` connections to each target, sequential to avoid self-induced jitter.
 * @returns {Promise<{online:boolean, latency:number|null, jitter:number|null, loss:number, reachable:number, total:number, perTarget:object[]}>}
 */
async function probeRound(targets, { samples = 3, timeout = 3000, connect = tcpConnectTime } = {}) {
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
    perTarget.push({ target: `${t.host}:${t.port}`, ok: times.length > 0, latency: median(times), jitter: times.length > 1 ? trimmedJitter(times) : null, error: times.length ? null : lastError });
  }
  const reachable = perTarget.filter((p) => p.ok).length;
  const best = perTarget.filter((p) => p.ok).map((p) => p.latency);
  return {
    online: reachable > 0,
    // Median of the per-target medians: robust to one slow anycast node
    latency: best.length ? median(best) : null,
    // Jitter is computed per target (samples to different servers are not comparable), then the median
    jitter: median(perTarget.map((p) => p.jitter).filter((j) => j != null)),
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

module.exports = { tcpConnectTime, tcpRtt, rttSeries, parseTargets, probeRound, dnsTime, median, jitter, trimmedJitter };
