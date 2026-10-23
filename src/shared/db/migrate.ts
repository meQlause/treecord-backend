import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import { Migrator, type MigrationProvider, type MigrationResult } from 'kysely/migration';

// be-stack §1: Kysely's Migrator over raw SQL files, applied in name order — 000 bootstrap, 101–109 the frozen
// files byte-identical, 200 the additions (ADR-019). Each file runs as one migration inside a transaction.
const sqlFolder = (folder: string): MigrationProvider => ({
  getMigrations: async () => {
    const files = (await readdir(folder)).filter((file) => file.endsWith('.sql')).sort();

    return Object.fromEntries(
      files.map((file) => [
        file.replace(/\.sql$/, ''),
        {
          up: async (database: Kysely<unknown>) => {
            await sql.raw(await readFile(join(folder, file), 'utf8')).execute(database);
          },
        },
      ]),
    );
  },
});

/** Applies every migration not yet applied; throws on the first failure. Returns what ran. */
export const migrateToLatest = async <Schema>(
  database: Kysely<Schema>,
  folder: string,
): Promise<MigrationResult[]> => {
  const migrator = new Migrator({ db: database, provider: sqlFolder(folder) });
  const { error, results = [] } = await migrator.migrateToLatest();

  if (error !== undefined) {
    throw error;
  }

  return results;
};

/** Applies migrations up to and including `name`: for tests that need rows written before a later migration. */
export const migrateUpTo = async <Schema>(
  database: Kysely<Schema>,
  folder: string,
  name: string,
): Promise<MigrationResult[]> => {
  const migrator = new Migrator({ db: database, provider: sqlFolder(folder) });
  const { error, results = [] } = await migrator.migrateTo(name);

  if (error !== undefined) {
    throw error;
  }

  return results;
};
