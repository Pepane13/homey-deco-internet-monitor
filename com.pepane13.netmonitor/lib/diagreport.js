'use strict';

/**
 * Builds the diagnostic report exported from the app settings page: a readable text part
 * followed by the raw data in JSON. Pure function, no Homey dependency, tested on its own.
 * Passwords never reach this function; the public IP and MAC addresses are partly masked.
 */

/** 90.1.2.3 -> 90.1.*.*, 2a01:cb00:1:2::1 -> 2a01:cb00:*** */
function maskIp(ip) {
  const s = String(ip || '');
  if (!s) return '';
  if (s.includes(':')) return `${s.split(':').slice(0, 2).join(':')}:***`;
  const p = s.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.*.*` : s;
}

/** AA:BB:CC:DD:EE:FF -> AA:BB:CC:**:**:FF */
function maskMac(mac) {
  const p = String(mac || '').split(':');
  return p.length === 6 ? `${p[0]}:${p[1]}:${p[2]}:**:**:${p[5]}` : String(mac || '');
}

function fmtDate(iso, timeZone) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('sv-SE', { timeZone }); // YYYY-MM-DD HH:MM:SS
  } catch (e) {
    return String(iso);
  }
}

const show = (v) => (v === null || v === undefined || v === '' ? '—' : v);

/**
 * @param {object} p
 * @param {string} p.generated ISO date
 * @param {string} p.timeZone Homey time zone
 * @param {string} p.appVersion
 * @param {string} p.homeyVersion
 * @param {object} p.appSettings { log_level, notify_* }
 * @param {object[]} p.devices from Device#getDiagReport(): { driver, name, status, settings, values }
 * @param {object[]} p.log diagnostic log entries { t, l, s, c, m }, oldest first
 * @returns {{ text: string, data: object, filename: string }}
 */
function buildReport(p) {
  const tz = p.timeZone || 'UTC';
  const s = p.appSettings || {};
  const onOff = (v, def) => ((v === null || v === undefined ? def : v) ? 'on' : 'off');
  const L = [];

  L.push('Deco & Internet Monitor — diagnostic report');
  L.push(`Generated: ${fmtDate(p.generated, tz)} (${tz})`);
  L.push(`App version: ${p.appVersion || '?'} | Homey: ${p.homeyVersion || '?'}`);
  L.push(`Log level: ${s.log_level || 'info'} | Notifications: Internet ${onOff(s.notify_internet, true)}, `
    + `quality ${onOff(s.notify_quality, false)}, box ${onOff(s.notify_box, true)}, Deco ${onOff(s.notify_deco, true)}`);

  const devices = (p.devices || []).map((d) => {
    const settings = { ...(d.settings || {}) };
    delete settings.password;
    const values = { ...(d.values || {}) };
    if (values.netmon_ip) values.netmon_ip = maskIp(values.netmon_ip);
    if (settings.node_mac) settings.node_mac = maskMac(settings.node_mac);
    return { ...d, settings, values };
  });

  for (const d of devices) {
    const st = d.status || {};
    L.push('');
    L.push(`== ${d.driver}: ${d.name} ==`);
    Object.entries(st).forEach(([k, v]) => {
      const val = v && typeof v === 'object' ? JSON.stringify(v) : v;
      L.push(`${k}: ${show(/(^|_)(t|time|since|lastOk|ts)$|At$/.test(k) && typeof v === 'string' ? fmtDate(v, tz) : val)}`);
    });
    if (Object.keys(d.values).length) {
      L.push('Current values:');
      Object.entries(d.values).forEach(([k, v]) => L.push(`  ${k}: ${show(v)}`));
    }
    const set = Object.entries(d.settings);
    if (set.length) L.push(`Settings: ${set.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }

  const log = p.log || [];
  L.push('');
  L.push(`== Diagnostic log (${log.length} entries, oldest first) ==`);
  for (const e of log) {
    L.push(`${fmtDate(e.t, tz)} ${String(e.l).toUpperCase().padEnd(5)} [${e.c}] ${e.s}: ${e.m}`);
  }

  const data = {
    generated: p.generated,
    timeZone: tz,
    appVersion: p.appVersion,
    homeyVersion: p.homeyVersion,
    appSettings: s,
    devices,
    log,
  };
  L.push('');
  L.push('== Raw data (JSON) ==');
  L.push(JSON.stringify(data, null, 1));

  const stamp = fmtDate(p.generated, tz).replace(/[: ]/g, '-').slice(0, 16);
  return { text: L.join('\n'), data, filename: `netmonitor-diagnostic-${stamp}.txt` };
}

module.exports = { buildReport, maskIp, maskMac };
