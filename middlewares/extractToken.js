const jwt = require('jsonwebtoken');
const config = require('../config');

/** Maps Keycloak token claims to a UI principal, with a role from the realm roles. */
function principalFromClaims(tokenData) {
  const roles = tokenData.realm_access?.roles || [];
  const role = roles.includes(config.keycloak.adminRole) ? 'admin'
    : roles.includes(config.keycloak.operatorRole) ? 'operator'
      : 'viewer';
  return {
    id: tokenData.sub,
    username: tokenData.preferred_username || tokenData.sub,
    displayName: tokenData.name || null,
    role,
    source: 'keycloak'
  };
}

/**
 * After keycloak.protect(): decodes the (already validated) Keycloak token
 * into req.tokenData and maps it to req.user with a UI role from the realm
 * roles (KEYCLOAK_ADMIN_ROLE, KEYCLOAK_OPERATOR_ROLE, otherwise viewer).
 */
function extractToken(req, res, next) {
  try {
    const token = (req.headers.authorization || '').split(' ')[1];
    req.tokenData = jwt.decode(token) || {};
    req.user = principalFromClaims(req.tokenData);
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = extractToken;
module.exports.principalFromClaims = principalFromClaims;
