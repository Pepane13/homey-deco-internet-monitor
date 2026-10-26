'use strict';

/*
 * Pure helpers (no Homey dependency, unit-tested):
 *  - linkQuality(): 0-100 score of the Internet link seen from the box
 *  - DayStats: per-day min / max / average accumulators for the daily summary
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Linear score: 100 at or better than `good`, `floor` at or worse than `bad`. Works both ways. */
function scale(value, good, bad, floor = 0) {
  if (value == null || !Number.isFinite(value)) return null;
  const t = (value - good) / (bad - good);
  return Math.round(clamp(100 - t * (100 - floor), floor, 100));
}

/**
 * Internet link quality from the box point of view (0 = down, 100 = excellent).
 * Each component is scored 0-100; the result is a weighted mean of the available components,
 * capped so that one very bad component cannot be hidden by good ones (min + 30).
 * @param {object} m
 * @param {boolean} m.online   fibre / WAN link up
 * @param {number} [m.rxPower] received optical power, dBm (GPON: good >= -21, at risk <= -27)
 * @param {number} [m.latency] Internet latency, ms
 * @param {number} [m.jitter]  Internet jitter, ms
 * @param {number} [m.loss]    packet loss, %
 * @param {number} [m.lanLatency] latency Homey -> box, ms
 * @returns {{score:number, parts:object}}
 */
function linkQuality(m) {
  if (!m || m.online === false) return { score: 0, parts: { link: 0 } };
  const parts = {
    optical: scale(m.rxPower, -21, -28, 10),
    latency: scale(m.latency, 20, 100, 10),
    jitter: scale(m.jitter, 10, 50, 10),
    loss: m.loss == null ? null : Math.round(clamp(100 - m.loss * 10, 0, 100)),
    lan: scale(m.lanLatency, 10, 80, 30),
  };
  const weights = { optical: 0.15, latency: 0.3, jitter: 0.2, loss: 0.25, lan: 0.1 };
  let sum = 0;
  let w = 0;
  let min = 100;
  for (const [k, v] of Object.entries(parts)) {
    if (v == null) continue;
    sum += v * weights[k];
    w += weights[k];
    min = Math.min(min, v);
  }
  if (!w) return { score: 100, parts };
  const score = Math.round(Math.min(sum / w, min + 30));
  return { score, parts };
}

class DayStats {
  constructor(state) {
    this.day = null;
    this.m = {}; // metric -> { n, sum, min, max, maxAt }
    this.counters = {}; // name -> number
    this.events = []; // short strings, kept for the summary
    if (state) Object.assign(this, state);
  }

  /** Returns the finished day's data when the day changed, else null. */
  roll(dayKey) {
    if (this.day === dayKey) return null;
    const done = this.day ? this.toJSON() : null;
    this.day = dayKey;
    this.m = {};
    this.counters = {};
    this.events = [];
    return done;
  }

  add(metric, value, ts = Date.now()) {
    if (value == null || !Number.isFinite(value)) return;
    const s = this.m[metric] || (this.m[metric] = { n: 0, sum: 0, min: value, max: value, maxAt: ts });
    s.n++;
    s.sum += value;
    if (value < s.min) s.min = value;
    if (value > s.max) { s.max = value; s.maxAt = ts; }
  }

  count(name, inc = 1) {
    this.counters[name] = (this.counters[name] || 0) + inc;
  }

  event(text) {
    this.events.push(text);
    if (this.events.length > 20) this.events.shift();
  }

  get(metric) {
    const s = this.m[metric];
    if (!s || !s.n) return null;
    return { avg: Math.round((s.sum / s.n) * 10) / 10, min: Math.round(s.min * 10) / 10, max: Math.round(s.max * 10) / 10, maxAt: s.maxAt, n: s.n };
  }

  toJSON() {
    return { day: this.day, m: this.m, counters: this.counters, events: this.events };
  }
}

/** Local calendar day key (YYYY-MM-DD) in the Homey time zone. */
function dayKey(ts, timeZone) {
  try {
    return new Date(ts).toLocaleDateString('sv-SE', { timeZone });
  } catch (e) {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

/** Local time HH:MM in the Homey time zone. */
function timeOf(ts, timeZone) {
  try {
    return new Date(ts).toLocaleTimeString('fr-FR', { timeZone, hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return new Date(ts).toISOString().slice(11, 16);
  }
}

module.exports = { linkQuality, scale, DayStats, dayKey, timeOf };
