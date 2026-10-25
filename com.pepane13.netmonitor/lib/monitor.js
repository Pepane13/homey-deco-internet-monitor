'use strict';

/*
 * Pure state machines (no Homey dependency, unit-tested):
 *  - OutageTracker: confirmed outages from consecutive failed probe rounds
 *  - ThresholdWatch: per-metric degradation with N consecutive breaches / N consecutive recoveries
 */

class OutageTracker {
  constructor({ confirm = 2, state } = {}) {
    this.confirm = confirm;
    this.online = true;
    this.failures = 0;
    this.firstFailure = null;
    this.outageStart = null;
    this.day = null;
    this.count = 0; // outages today
    this.downtime = 0; // seconds today (closed outages)
    if (state) Object.assign(this, state);
  }

  _rollDay(ts) {
    const d = new Date(ts).toDateString();
    if (this.day !== d) {
      this.day = d;
      this.count = 0;
      this.downtime = 0;
    }
  }

  /**
   * @param {boolean} ok result of the probe round
   * @param {number} ts epoch ms
   * @returns {null|{type:'down', since:number}|{type:'up', since:number, duration:number}}
   */
  update(ok, ts = Date.now()) {
    this._rollDay(ts);
    if (!ok) {
      if (this.failures === 0) this.firstFailure = ts;
      this.failures++;
      if (this.online && this.failures >= this.confirm) {
        this.online = false;
        this.outageStart = this.firstFailure;
        this.count++;
        return { type: 'down', since: this.outageStart };
      }
      return null;
    }
    this.failures = 0;
    this.firstFailure = null;
    if (!this.online) {
      this.online = true;
      const duration = Math.max(0, Math.round((ts - this.outageStart) / 1000));
      const since = this.outageStart;
      this.downtime += duration;
      this.outageStart = null;
      return { type: 'up', since, duration };
    }
    return null;
  }

  /** Downtime today including the outage in progress, seconds. */
  downtimeToday(ts = Date.now()) {
    this._rollDay(ts);
    const running = !this.online && this.outageStart ? Math.round((ts - Math.max(this.outageStart, new Date(this.day).getTime())) / 1000) : 0;
    return this.downtime + running;
  }

  toJSON() {
    const { confirm, ...state } = this;
    return state;
  }
}

class ThresholdWatch {
  /**
   * @param {object} rules { metric: { limit:number, dir:'min'|'max' } }
   * @param {number} consecutive breaches (and recoveries) needed to change state
   */
  constructor(rules = {}, consecutive = 2, state) {
    this.rules = rules;
    this.consecutive = consecutive;
    this.state = state || {}; // metric -> { bad:boolean, breach:number, ok:number }
  }

  setRules(rules, consecutive) {
    this.rules = rules;
    if (consecutive) this.consecutive = consecutive;
  }

  isBreach(metric, value) {
    const r = this.rules[metric];
    if (!r || r.limit == null || r.limit === 0 || value == null || !Number.isFinite(value)) return null;
    return r.dir === 'min' ? value < r.limit : value > r.limit;
  }

  /** @returns {null|{type:'degraded'|'recovered', metric, value, limit}} */
  update(metric, value) {
    const breach = this.isBreach(metric, value);
    if (breach == null) return null;
    const s = this.state[metric] || (this.state[metric] = { bad: false, breach: 0, ok: 0 });
    if (breach) {
      s.breach++;
      s.ok = 0;
      if (!s.bad && s.breach >= this.consecutive) {
        s.bad = true;
        return { type: 'degraded', metric, value, limit: this.rules[metric].limit };
      }
    } else {
      s.ok++;
      s.breach = 0;
      if (s.bad && s.ok >= this.consecutive) {
        s.bad = false;
        return { type: 'recovered', metric, value, limit: this.rules[metric].limit };
      }
    }
    return null;
  }

  degraded() {
    return Object.keys(this.state).filter((m) => this.state[m].bad && this.rules[m] && this.rules[m].limit);
  }

  reset(metric) {
    delete this.state[metric];
  }
}

/**
 * 32-bit wrapping counter delta -> Mbit/s. Returns null on the first sample or when the jump is
 * physically impossible (counter reset by a reboot): a wrap is accepted only if the resulting
 * rate stays below `maxMbps` (Livebox 5 WAN port: 2.5 Gbit/s).
 */
function counterRate(prev, cur, seconds, { wrap = 2 ** 32, maxMbps = 2500 } = {}) {
  if (prev == null || cur == null || !(seconds > 0)) return null;
  let delta = cur - prev;
  if (delta < 0) delta += wrap;
  const mbps = (delta * 8) / seconds / 1e6;
  return mbps > maxMbps ? null : mbps;
}

module.exports = { OutageTracker, ThresholdWatch, counterRate };
