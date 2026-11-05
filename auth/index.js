const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const { Strategy: JwtStrategy, ExtractJwt } = require('passport-jwt');
const jwt = require('jsonwebtoken');
const config = require('../config');
const User = require('../models/User');

/**
 * Local login (when Keycloak is not configured): username/password checked
 * against the users table, then a short access token and a refresh token.
 * Both carry the user's token_version: a password change or disabling the
 * user invalidates them.
 */

const ISSUER = 'udc-ui-api';

passport.use('login', new LocalStrategy({ usernameField: 'username', passwordField: 'password', session: false },
  async (username, password, done) => {
    try {
      const user = await User.verify(username, password);
      return user ? done(null, user) : done(null, false, 'Invalid username or password');
    } catch (error) {
      return done(error);
    }
  }));

passport.use('jwt', new JwtStrategy({
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
  secretOrKey: config.auth.secret,
  issuer: ISSUER,
  algorithms: ['HS256']
}, async (claims, done) => {
  try {
    if (claims.typ !== 'access') return done(null, false);
    const user = await User.findActive(claims.sub);
    if (!user || user.token_version !== claims.tv) return done(null, false);
    return done(null, toPrincipal(user));
  } catch (error) {
    return done(error);
  }
}));

/** What the routes see as req.user. */
function toPrincipal(user) {
  return { id: user.id, username: user.username, displayName: user.display_name, role: user.role, source: 'local' };
}

function issueTokens(user) {
  const claims = { sub: user.id, tv: user.token_version };
  return {
    accessToken: jwt.sign({ ...claims, typ: 'access' }, config.auth.secret, { issuer: ISSUER, expiresIn: config.auth.accessTtl }),
    refreshToken: jwt.sign({ ...claims, typ: 'refresh' }, config.auth.secret, { issuer: ISSUER, expiresIn: config.auth.refreshTtl })
  };
}

/** Claims of a valid refresh token, or null. */
function verifyRefresh(token) {
  try {
    const claims = jwt.verify(token, config.auth.secret, { issuer: ISSUER, algorithms: ['HS256'] });
    return claims.typ === 'refresh' ? claims : null;
  } catch {
    return null;
  }
}

module.exports = { passport, issueTokens, verifyRefresh, toPrincipal };
