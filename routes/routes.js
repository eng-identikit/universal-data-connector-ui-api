const express = require('express');
const config = require('../config');
const { passport } = require('../auth');
const { getKeycloak } = require('../middlewares/keycloak');
const extractToken = require('../middlewares/extractToken');
const checkRole = require('../middlewares/checkRole');
const { httpError } = require('../services/errors');

const router = express.Router();

/** Bearer token required: Keycloak's when KEYCLOAK_URL is set, otherwise this service's own. */
function authenticate() {
  const keycloak = getKeycloak();
  if (keycloak) return [keycloak.protect(), extractToken, checkRole];
  return (req, res, next) => passport.authenticate('jwt', { session: false }, (error, user) => {
    if (error) return next(error);
    if (!user) return next(httpError(401, 'Missing, invalid or expired token'));
    req.user = user;
    next();
  })(req, res, next);
}

router.use('/basic', require('./basic_routes'));
router.use('/auth', authenticate(), require('./secure_routes'));


module.exports = router;
