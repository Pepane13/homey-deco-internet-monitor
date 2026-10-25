'use strict';

const https = require('https');
const http = require('http');
const { median, jitter } = require('./probe');

/*
 * Binary-free speed test against Cloudflare's public speed test endpoints
 * (the ones used by speed.cloudflare.com): GET /__down?bytes=N and POST /__up.
 * Several parallel streams saturate the link; the first second (TCP slow start) is discarded.
 */

const DEFAULT_BASE = 'https://speed.cloudflare.com';
const UA = 'Homey-NetworkMonitor';

function agentFor(url) {
  const lib = url.startsWith('https:') ? https : http;
  return { lib, agent: new lib.Agent({ keepAlive: true, maxSockets: 16 }) };
}

function now() {
  return Number(process.hrtime.bigint()) / 1e6;
}

/** Server processing time from the Server-Timing header (Cloudflare: cfRequestDuration;dur=1.2). */
function serverTime(headers) {
  const m = /dur=([\d.]+)/.exec(headers['server-timing'] || '');
  return m ? Number(m[1]) : 0;
}

function get(lib, agent, url, { onData, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const start = now();
    const req = lib.get(url, { agent, headers: { 'User-Agent': UA }, timeout }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.on('data', (c) => onData && onData(c.length));
      res.on('end', () => resolve({ ms: now() - start, headers: res.headers }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    get.active.add(req);
    req.on('close', () => get.active.delete(req));
  });
}
get.active = new Set();

/** POSTs `size` bytes in 64 kB slices, reporting progress as the socket accepts them. */
function post(lib, agent, url, size, { onProgress, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = lib.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || undefined,
      path: `${u.pathname}${u.search}`,
      agent,
      timeout,
      headers: { 'User-Agent': UA, 'Content-Type': 'application/octet-stream', 'Content-Length': size },
    }, (res) => {
      res.resume();
      res.on('end', () => (res.statusCode < 300 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    get.active.add(req);
    req.on('close', () => get.active.delete(req));
    let sent = 0;
    const pump = () => {
      while (sent < size) {
        const n = Math.min(SLICE.length, size - sent);
        sent += n;
        const ok = req.write(n === SLICE.length ? SLICE : SLICE.subarray(0, n), () => onProgress && onProgress(n));
        if (!ok) { req.once('drain', pump); return; }
      }
      req.end();
    };
    pump();
  });
}
const SLICE = Buffer.alloc(64 * 1024, 0x61);

async function measureLatency(lib, agent, base, count) {
  const samples = [];
  // First request opens the TLS connection and is not counted
  await get(lib, agent, `${base}/__down?bytes=0`);
  for (let i = 0; i < count; i++) {
    const { ms, headers } = await get(lib, agent, `${base}/__down?bytes=0`);
    samples.push(Math.max(0, ms - serverTime(headers)));
  }
  return { latency: median(samples), jitter: jitter(samples) };
}

/** Runs `streams` loops of `fn` until the deadline, counting bytes after the warm-up. */
async function saturate({ streams, durationMs, warmupMs, fn }) {
  const t0 = now();
  const deadline = t0 + durationMs;
  let bytes = 0;
  let failures = 0;
  const count = (n) => { if (now() >= t0 + warmupMs) bytes += n; };
  const loop = async () => {
    while (now() < deadline) {
      try {
        await fn(count, deadline);
      } catch (e) {
        if (now() >= deadline) break; // aborted at the deadline
        failures++;
        if (failures > streams * 3) throw e;
      }
    }
  };
  const timer = setTimeout(() => { for (const r of get.active) r.destroy(); }, durationMs + 500);
  try {
    await Promise.all(Array.from({ length: streams }, loop));
  } finally {
    clearTimeout(timer);
  }
  const measured = Math.min(now(), deadline + 500) - (t0 + warmupMs);
  return measured > 0 ? (bytes * 8) / (measured / 1000) / 1e6 : 0;
}

/**
 * @param {object} o
 * @param {number} o.durationS  duration of each direction, seconds
 * @param {number} o.streams    parallel connections
 * @returns {Promise<{download:number, upload:number, latency:number, jitter:number, server:string|null, bytes:number}>}
 */
async function runSpeedtest({ baseUrl = DEFAULT_BASE, durationS = 8, streams = 4, chunkMb = 25, uploadChunkMb = 4, warmupS = 1 } = {}) {
  const base = baseUrl.replace(/\/+$/, '');
  const { lib, agent } = agentFor(base);
  let totalBytes = 0;
  try {
    const lat = await measureLatency(lib, agent, base, 8);
    let colo = null;

    const down = await saturate({
      streams,
      durationMs: durationS * 1000,
      warmupMs: warmupS * 1000,
      fn: async (count) => {
        const r = await get(lib, agent, `${base}/__down?bytes=${chunkMb * 1e6}`, {
          timeout: (durationS + 5) * 1000,
          onData: (n) => { totalBytes += n; count(n); },
        });
        colo = colo || r.headers['cf-ray'] || null;
      },
    });

    const up = await saturate({
      streams,
      durationMs: durationS * 1000,
      warmupMs: warmupS * 1000,
      fn: async (count) => {
        await post(lib, agent, `${base}/__up`, uploadChunkMb * 1e6, {
          timeout: (durationS + 5) * 1000,
          onProgress: (n) => { totalBytes += n; count(n); },
        });
      },
    });

    return {
      download: Math.round(down * 10) / 10,
      upload: Math.round(up * 10) / 10,
      latency: Math.round(lat.latency * 10) / 10,
      jitter: Math.round(lat.jitter * 10) / 10,
      server: colo ? String(colo).split('-').pop() : null,
      bytes: totalBytes,
    };
  } finally {
    agent.destroy();
  }
}

module.exports = { runSpeedtest, DEFAULT_BASE };
