const express = require('express');
const config = require('../../config');
const { pool } = require('../../db');
const User = require('../../models/User');
const { passport, issueTokens, verifyRefresh, toPrincipal } = require('../../auth');
const { httpError } = require('../../services/errors');

const router = express.Router();

/** How the SPA logs in: local form, or Keycloak (with where and which client). */
router.get('/config', (req, res) => {
  res.json(config.keycloak.url
    ? { auth: 'keycloak', keycloak: { url: config.keycloak.url, realm: config.keycloak.realm, clientId: config.keycloak.uiClientId } }
    : { auth: 'local' });
});

router.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (error) {
    res.status(503).json({ status: 'unavailable', error: error.message });
  }
});

router.post('/login', (req, res, next) => {
  if (config.keycloak.url) return next(httpError(400, 'Log in through Keycloak'));
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') return next(httpError(400, 'username and password are required'));
  passport.authenticate('login', { session: false }, (error, user, message) => {
    if (error) return next(error);
    if (!user) return next(httpError(401, message || 'Invalid username or password'));
    res.json({ ...issueTokens(user), user: toPrincipal(user) });
  })(req, res, next);
});

router.post('/refresh', async (req, res, next) => {
  try {
    const claims = verifyRefresh(req.body?.refreshToken);
    const user = claims && await User.findActive(claims.sub);
    if (!user || user.token_version !== claims.tv) throw httpError(401, 'Invalid or expired refresh token');
    res.json({ ...issueTokens(user), user: toPrincipal(user) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
