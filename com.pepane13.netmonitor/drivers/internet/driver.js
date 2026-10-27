'use strict';

const Homey = require('homey');

module.exports = class InternetDriver extends Homey.Driver {
  async onInit() {
    this.homey.flow.getConditionCard('internet_is_online').registerRunListener(({ device }) => device.isOnline());
    this.homey.flow.getConditionCard('quality_is_ok').registerRunListener(({ device }) => device.isQualityOk());
    this.homey.flow.getActionCard('run_speedtest').registerRunListener(async ({ device }) => {
      await device.runSpeedtest();
      return true;
    });
    this.homey.flow.getActionCard('run_speedtest_tokens').registerRunListener(async ({ device }) => {
      const r = await device.runSpeedtest();
      return { download: r.download, upload: r.upload, latency: r.latency };
    });
  }

  async onPairListDevices() {
    if (this.getDevices().length) return [];
    return [{ name: 'Internet Link Monitoring', data: { id: 'internet' } }];
  }
};
