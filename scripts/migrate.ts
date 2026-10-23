// npm run db:migrate — applies migrations/ to DATABASE_URL (ADR-019), then prints what ran.
import { readConfig } from '../src/config.js';
import { createDatabase } from '../src/shared/db/database.js';
import { migrateToLatest } from '../src/shared/db/migrate.js';

const config = readConfig();
const database = createDatabase({
  url: config.DATABASE_URL,
  poolMax: 1,
  timeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
  onIdleError: (error) => console.error('postgres idle connection dropped', error.message),
});

try {
  const results = await migrateToLatest(database, 'migrations');

  console.log(
    results.length === 0
      ? 'up to date'
      : results.map((result) => `${result.status} ${result.migrationName}`).join('\n'),
  );
} finally {
  await database.destroy();
}
