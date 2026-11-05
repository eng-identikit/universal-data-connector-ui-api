const crypto = require('crypto');
const config = require('./config');
const User = require('./models/User');
const Udc = require('./models/Udc');

/** First start: the admin user (local login) and the UDC of the same stack, when configured. */
module.exports = {
  async createAdmin() {
    if (config.keycloak.url || (await User.count()) > 0) return;
    let password = config.admin.password;
    if (!password) {
      password = crypto.randomBytes(12).toString('base64url');
      console.log(`Admin '${config.admin.username}' created with password: ${password} (shown once, change it)`);
    } else {
      console.log(`Admin '${config.admin.username}' created from UI_ADMIN_PASSWORD`);
    }
    try {
      await User.create({ username: config.admin.username, password, displayName: 'Administrator', role: 'admin' });
    } catch (error) {
      // Another instance created it at the same time
      if (error.status !== 409) throw error;
    }
  },

  async registerDefaultUdc() {
    const { name, url, publicUrl, apiKey } = config.defaultUdc;
    if (!url || !apiKey || (await Udc.count()) > 0) return;
    await Udc.create({ name, url, publicUrl, apiKey, position: { x: 0, y: 0 } }, 'seed');
    console.log(`UDC '${name}' registered (${url})`);
  }
};
