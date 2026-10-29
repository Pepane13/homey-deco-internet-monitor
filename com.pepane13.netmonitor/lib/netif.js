'use strict';

const os = require('os');

/**
 * Socket errors raised by Homey's own network stack before anything leaves the device: no route,
 * interface down, or no usable local address. When the box itself fails with one of these, the
 * problem is Homey's link (cable, adapter, switch port, lost IP address), not the box or the Internet.
 * A dead box or network gives ETIMEDOUT / EHOSTUNREACH instead.
 */
const LOCAL_NET_ERRORS = new Set(['ENETUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL']);

function isLocalNetError(code) {
  return LOCAL_NET_ERRORS.has(String(code || '').toUpperCase());
}

/**
 * External network interfaces seen by the app, with their IPv4 address and prefix.
 * @param {Function} [getInterfaces] os.networkInterfaces, replaceable in tests
 * @returns {{text: string, hasIPv4: boolean, list: {name: string, address: string|null}[]}}
 */
function interfaceSnapshot(getInterfaces = os.networkInterfaces) {
  let all = {};
  try {
    all = getInterfaces() || {};
  } catch (e) {
    return { text: `? (${e.code || e.message})`, hasIPv4: true, list: [] };
  }
  const list = [];
  for (const [name, addrs] of Object.entries(all)) {
    const external = (addrs || []).filter((a) => a && !a.internal);
    if (!external.length) continue;
    const v4 = external.find((a) => a.family === 'IPv4' || a.family === 4);
    list.push({ name, address: v4 ? (v4.cidr || v4.address) : null });
  }
  const hasIPv4 = list.some((i) => i.address);
  const text = list.length ? list.map((i) => `${i.name} ${i.address || '—'}`).join(', ') : '—';
  return { text, hasIPv4, list };
}

module.exports = { LOCAL_NET_ERRORS, isLocalNetError, interfaceSnapshot };
