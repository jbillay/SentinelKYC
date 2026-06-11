const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const schema = require('./schema');
const { log } = require('../services/log');

if (!process.env.DATABASE_URL) {
  throw new Error(
    '[db] DATABASE_URL is not set. See server/db/SETUP.md for one-time Postgres setup.'
  );
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.on('error', (err) => {
  log.error(`[db] unexpected pg pool error: ${err.message}`);
});

const db = drizzle(pool, { schema });

module.exports = { db, pool, schema };
