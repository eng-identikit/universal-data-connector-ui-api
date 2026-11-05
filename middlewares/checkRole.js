const config = require('../config');
const { httpError } = require('../services/errors');

/** With Keycloak: the realm role KEYCLOAK_AUTHORIZED_ROLE (when set) is required to use the UI at all. */
module.exports = (req, res, next) => {
  if (!config.keycloak.authorizedRole) return next();
  const roles = req.tokenData?.realm_access?.roles || [];
  if (roles.includes(config.keycloak.authorizedRole)) return next();
  next(httpError(403, 'Access denied: you do not have permission to access this'));
};
