const config = require('../config');

/**
 * Keycloak in bearer-only mode, as in iotagent-ui-bff: the SPA logs in on
 * Keycloak and sends its token; this service only validates it. Created only
 * when KEYCLOAK_URL is set.
 */
let keycloak = null;

function getKeycloak() {
  if (!config.keycloak.url) return null;
  if (!keycloak) {
    const Keycloak = require('keycloak-connect');
    keycloak = new Keycloak({}, {
      realm: config.keycloak.realm,
      'auth-server-url': config.keycloak.url,
      'ssl-required': 'external',
      resource: config.keycloak.clientId,
      'bearer-only': true
    });
  }
  return keycloak;
}

module.exports = { getKeycloak };
