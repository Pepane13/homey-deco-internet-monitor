'use strict';

const Homey = require('homey');

const IP = /^\d{1,3}(\.\d{1,3}){3}$/;

module.exports = class DecoDriver extends Homey.Driver {
  async onInit() {
    this.homey.flow.getConditionCard('node_is_online').registerRunListener(({ device }) => device.isOnline());
    this.homey.flow.getConditionCard('client_is_connected').registerRunListener(({ device, name }) => device.isClientConnected(name));
  }

  async onPair(session) {
    // Single custom view (same pattern as the Livebox): login, then the view lists the nodes and creates the devices
    session.setHandler('login', async ({ host, password }) => {
      // iOS French keyboards may only offer a comma: accept 192,168,68,1 as well
      host = String(host || '').trim().replace(/[,;\s]+/g, '.').replace(/\.+/g, '.');
      if (!IP.test(host)) throw new Error(this.homey.__('errors.invalid_ip'));
      if (!password) throw new Error(this.homey.__('errors.password_required'));
      // The shared hub client is used, so pairing does not open a second owner session
      const hub = this.homey.app.getDecoHub(host, password);
      let found;
      try {
        found = await hub.client.listDecos();
      } catch (err) {
        this.error('Deco pairing failed:', err.code, err.message);
        if (!hub.subscribers.size) this.homey.app.decoHubs.delete(host);
        if (err.code === 'EAUTH') throw new Error(this.homey.__('errors.deco_auth'));
        if (err.code === 'EUNSUPPORTED') throw new Error(this.homey.__('errors.unsupported'));
        if (['ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(err.code)) {
          throw new Error(`${this.homey.__('errors.unreachable')} ${err.message}`);
        }
        throw new Error(`${this.homey.__('errors.read_failed')} ${err.message}`);
      }
      const paired = new Set(this.getDevices().map((d) => d.getData().id));
      return found
        .sort((a, b) => Number(b.master) - Number(a.master)) // main Deco first
        .map((d) => ({
          paired: paired.has(d.mac),
          master: d.master,
          device: {
            name: d.name,
            data: { id: d.mac },
            settings: { host, password },
            store: { model: d.model, master: d.master },
          },
        }));
    });
  }
};
