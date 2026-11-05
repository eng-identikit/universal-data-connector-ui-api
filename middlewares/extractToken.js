const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * After keycloak.protect(): decodes the (already validated) Keycloak token
 * into req.tokenData and maps it to req.user with a UI role from the realm
 * roles (KEYCLOAK_ADMIN_ROLE, KEYCLOAK_OPERATOR_ROLE, otherwise viewer).
 */
module.exports = (req, res, next) => {
  try {
    const token = (req.headers.authorization || '').split(' ')[1];
    const tokenData = jwt.decode(token) || {};
    req.tokenData = tokenData;
    const roles = tokenData.realm_access?.roles || [];
    const role = roles.includes(config.keycloak.adminRole) ? 'admin'
      : roles.includes(config.keycloak.operatorRole) ? 'operator'
        : 'viewer';
    req.user = {
      id: tokenData.sub,
      username: tokenData.preferred_username || tokenData.sub,
      displayName: tokenData.name || null,
      role,
      source: 'keycloak'
    };
    next();
  } catch (error) {
    next(error);
  }
};
