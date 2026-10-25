'use strict';

const { LiveboxClient } = require('./livebox');
const { BboxClient } = require('./bbox');
const { SfrClient } = require('./sfrbox');

/*
 * French ISP boxes supported by the "Internet box" driver, chosen by the user before pairing.
 * password: 'required' | 'optional' (only if the box asks for it) | 'none'.
 */
const OPERATORS = {
  orange: {
    label: 'Orange', family: 'livebox', defaultHost: '192.168.1.1', password: 'required',
    models: 'Livebox 4, 5, 6, 7',
  },
  sosh: {
    label: 'Sosh', family: 'livebox', defaultHost: '192.168.1.1', password: 'required',
    models: 'Livebox 4, 5, 6, 7',
  },
  bouygues: {
    label: 'Bouygues Telecom', family: 'bbox', defaultHost: '192.168.1.254', password: 'optional',
    models: 'Bbox Fibre, Bbox Ultym, Bbox Wi-Fi 6 / 7, Bbox Must',
  },
  sfr: {
    label: 'SFR / RED by SFR', family: 'sfr', defaultHost: '192.168.1.1', password: 'optional',
    models: 'SFR Box 8, 8X, Box 10, NB6V / NB6VAC',
  },
};

function createBoxClient(operator, { host, username, password, timeout } = {}) {
  const op = OPERATORS[operator] || OPERATORS.orange;
  const opts = { host: host || op.defaultHost, username, password, timeout };
  switch (op.family) {
    case 'bbox': return new BboxClient(opts);
    case 'sfr': return new SfrClient(opts);
    default: return new LiveboxClient(opts);
  }
}

module.exports = { OPERATORS, createBoxClient };
