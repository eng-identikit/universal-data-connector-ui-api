const express = require('express');
const config = require('../../config');
const User = require('../../models/User');
const { requireRole } = require('../../middlewares/requireRole');
const { httpError } = require('../../services/errors');
const { issueTokens } = require('../../auth');

/** Routes behind authentication (req.user: { id, username, displayName, role, source }). */
const router = express.Router();
const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/me', (req, res) => res.json({ ...req.user, auth: config.keycloak.url ? 'keycloak' : 'local' }));

// Own password (local login). Older tokens stop working: the answer carries a new pair
router.post('/me/password', handle(async (req, res) => {
  if (req.user.source !== 'local') throw httpError(400, 'Passwords are managed in Keycloak');
  const { currentPassword, newPassword } = req.body || {};
  const user = await User.verify(req.user.username, currentPassword);
  if (!user) throw httpError(400, 'Current password is wrong');
  await User.update(user.id, { password: newPassword });
  res.json(issueTokens(await User.findActive(user.id)));
}));

// ─── Users (admin, local login only) ─────────────────────────────────────
const users = express.Router();
users.use(requireRole('admin'), (req, res, next) => next(config.keycloak.url ? httpError(400, 'Users are managed in Keycloak') : undefined));
users.get('/', handle(async (req, res) => res.json({ users: await User.list() })));
users.post('/', handle(async (req, res) => res.status(201).json(await User.create(req.body || {}))));
users.patch('/:id', handle(async (req, res) => res.json(await User.update(req.params.id, req.body || {}))));
users.delete('/:id', handle(async (req, res) => {
  if (req.params.id === req.user.id) throw httpError(400, 'You cannot delete yourself');
  await User.remove(req.params.id);
  res.status(204).end();
}));
router.use('/users', users);

router.use('/udc', require('./udc'));

module.exports = router;
