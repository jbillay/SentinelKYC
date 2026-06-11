const path = require('path');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
const { db, pool } = require('./client');

async function main() {
  const migrationsFolder = path.join(__dirname, 'migrations');
  console.log(`[db] running migrations from ${migrationsFolder}`);
  await migrate(db, { migrationsFolder });
  console.log('[db] migrations complete');
}

main()
  .catch((err) => {
    console.error('[db] migration failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
