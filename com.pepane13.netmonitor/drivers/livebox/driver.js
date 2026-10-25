'use strict';

const Homey = require('homey');
const { OPERATORS, createBoxClient } = require('../../lib/boxes');

const IP = /^\d{1,3}(\.\d{1,3}){3}$/;

module.exports = class BoxDriver extends Homey.Driver {
  async onInit() {
    this.homey.flow.getConditionCard('wan_is_up').registerRunListener(({ device }) => device.isWanUp());
  }

  async onPair(session) {
    // Operator selector shown before the connection form
    session.setHandler('operators', async () => Object.entries(OPERATORS).map(([id, o]) => ({
      id, label: o.label, models: o.models, host: o.defaultHost, password: o.password,
    })));

    session.setHandler('test', async ({ operator, host, password }) => {
      const op = OPERATORS[operator];
      if (!op) throw new Error(this.homey.__('errors.operator_required'));
      // iOS French keyboards may only offer a comma: accept 192,168,1,1 as well
      host = String(host || op.defaultHost).trim().replace(/[,;\s]+/g, '.').replace(/\.+/g, '.');
      if (!IP.test(host)) throw new Error(this.homey.__('errors.invalid_ip'));
      if (op.password === 'required' && !password) throw new Error(this.homey.__('errors.password_required'));
      const client = createBoxClient(operator, { host, password, timeout: 8000 });
      try {
        const s = await client.getStatus();
        return {
          name: s.model && !/^(bbox|sfr box)$/i.test(s.model) ? s.model : `${op.label} – ${s.model || 'Box'}`,
          data: { id: `box-${operator}-${host}` },
          settings: { operator, host, username: 'admin', password: password || '', model: s.model || '', firmware: s.firmware || '' },
        };
      } catch (err) {
        this.error('Pairing test failed:', operator, err.code, err.message);
        if (err.code === 'EAUTH') throw new Error(this.homey.__(op.password === 'required' ? 'errors.auth' : 'errors.auth_optional'));
        if (err.code === 'ELOCKED') throw new Error(this.homey.__('errors.locked'));
        if (['ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(err.code)) {
          throw new Error(`${this.homey.__('errors.unreachable')} ${err.message}`);
        }
        if (err.code === 'EPROTO') throw new Error(this.homey.__('errors.wrong_operator'));
        throw new Error(`${this.homey.__('errors.read_failed')} ${err.message}`);
      }
    });
  }
};
