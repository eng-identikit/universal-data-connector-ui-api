const fs = require('fs');
const path = require('path');
const { Pool, Client } = require('pg');
const config = require('../config');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
// Serializes migrations when several instances start together
const MIGRATION_LOCK_ID = 74210932;

function connectionOptions(database) {
  if (config.db.url) {
    const url = new URL(config.db.url);
    if (database) url.pathname = `/${database}`;
    return { connectionString: url.toString() };
  }
  return {
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: database || config.db.name
  };
}

const pool = new Pool({ ...connectionOptions(), max: 10 });
pool.on('error', (error) => console.error(`Database pool error: ${error.message}`));

/** Creates the database when it does not exist yet (needs CREATEDB on the maintenance database). */
async function ensureDatabase() {
  const name = config.db.url ? new URL(config.db.url).pathname.slice(1) : config.db.name;
  const client = new Client(connectionOptions(config.db.maintenanceDb));
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) {
      await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
      console.log(`Database ${name} created`);
    }
  } finally {
    await client.end();
  }
}

/** Applies pending migrations (db/migrations/NNN_name.sql), each in a transaction. */
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map(r => r.name));
    for (const file of fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()) {
      if (applied.has(file)) continue;
      try {
        await client.query('BEGIN');
        await client.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`Migration applied: ${file}`);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${file} failed: ${error.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}

/** Runs fn(client) in a transaction. */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, ensureDatabase, migrate, withTransaction };
