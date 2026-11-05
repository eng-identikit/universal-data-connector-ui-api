const bcrypt = require('bcryptjs');
const { pool, withTransaction } = require('../db');
const { httpError } = require('../services/errors');

const ROLES = ['admin', 'operator', 'viewer'];
const USERNAME_RE = /^[A-Za-z0-9_.@-]{3,64}$/;
const SALT_ROUNDS = 10;

function toUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    disabled: row.disabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

/** At least one active admin must remain; throwing rolls the change back. */
async function assertAdminLeft(client) {
  const { rows } = await client.query("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND NOT disabled");
  if (!rows[0].n) throw httpError(409, 'At least one active admin is required');
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
}

const User = {
  ROLES,
  toUser,

  async list() {
    const { rows } = await pool.query('SELECT * FROM users ORDER BY username');
    return rows.map(toUser);
  },

  /** Raw row with hash and token_version, or null. */
  async findByUsername(username) {
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    return rows[0] || null;
  },

  async findActive(id) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1 AND NOT disabled', [id]);
    return rows[0] || null;
  },

  async get(id) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    if (!rows.length) throw httpError(404, `User '${id}' not found`);
    return toUser(rows[0]);
  },

  async create({ username, password, displayName, role = 'viewer' }) {
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) throw httpError(400, 'Username must be 3-64 chars of [A-Za-z0-9_.@-]');
    if (!ROLES.includes(role)) throw httpError(400, `role must be one of ${ROLES.join(', ')}`);
    checkPassword(password);
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, display_name, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO NOTHING RETURNING *`,
      [username, await bcrypt.hash(password, SALT_ROUNDS), displayName || null, role]
    );
    if (!rows.length) throw httpError(409, `Username '${username}' already exists`);
    return toUser(rows[0]);
  },

  async update(id, { displayName, password, role, disabled }) {
    const sets = [];
    const params = [id];
    const set = (column, value) => { params.push(value); sets.push(`${column} = $${params.length}`); };
    if (displayName !== undefined) set('display_name', displayName || null);
    if (role !== undefined) {
      if (!ROLES.includes(role)) throw httpError(400, `role must be one of ${ROLES.join(', ')}`);
      set('role', role);
    }
    if (disabled !== undefined) set('disabled', !!disabled);
    if (password !== undefined) {
      checkPassword(password);
      set('password_hash', await bcrypt.hash(password, SALT_ROUNDS));
    }
    if (!sets.length) throw httpError(400, 'Nothing to update');
    if (password !== undefined || disabled) sets.push('token_version = token_version + 1');
    return withTransaction(async (client) => {
      const { rows } = await client.query(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params);
      if (!rows.length) throw httpError(404, `User '${id}' not found`);
      await assertAdminLeft(client);
      return toUser(rows[0]);
    });
  },

  async remove(id) {
    await withTransaction(async (client) => {
      const { rowCount } = await client.query('DELETE FROM users WHERE id = $1', [id]);
      if (!rowCount) throw httpError(404, `User '${id}' not found`);
      await assertAdminLeft(client);
    });
  },

  async verify(username, password) {
    const row = await User.findByUsername(username);
    // Compare against a dummy hash for unknown users: same timing either way
    const ok = await bcrypt.compare(String(password || ''), row ? row.password_hash : '$2a$10$CwTycUXWue0Thq9StjUM0uJ8DPLKXt1FYlwYpQW2G3cAwjKoh2WZe');
    return row && ok && !row.disabled ? row : null;
  },

  async count() {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
    return rows[0].n;
  }
};

module.exports = User;
