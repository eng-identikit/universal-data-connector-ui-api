const { httpError } = require('../services/errors');

const RANK = { viewer: 1, operator: 2, admin: 3 };

/** Minimum UI role for a route: viewer < operator < admin. */
const requireRole = (min) => (req, res, next) => {
  if (RANK[req.user?.role] >= RANK[min]) return next();
  next(httpError(403, `Role '${min}' required`));
};

module.exports = { requireRole, RANK };
