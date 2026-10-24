// ADR-002, ADR-019: the frozen copies — src/generated/frozen/ and the nine migrations/1nn_*.sql — match their SHA-256
// fingerprints. ADR-021 retired the live comparison with a sibling checkout: the manifest alone guards the copies,
// and records where each one was copied from (azkawm/treecord-backend at `sourceCommit`).
//   node scripts/check-frozen.ts           check
//   node scripts/check-frozen.ts --write   record the fingerprints after a deliberate re-copy
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const FROZEN = 'src/generated/frozen';
const MANIFEST = join(FROZEN, 'manifest.json');
const FROZEN_MIGRATION = /^1\d\d_/;
// Each frozen root, which of its files are frozen, and the path each was copied from (SRS §2.6).
const ROOTS = [
  {
    dir: FROZEN,
    frozen: (file: string) => file !== 'manifest.json',
    // the attester is the pipeline's (phases.md B6c); every other copy is packages/shared's
    source: (file: string) =>
      file === 'attester.ts' ? 'packages/pipeline/src/attester.ts' : `packages/shared/src/${file}`,
  },
  {
    // migrations/101_20261016120000_core.sql is supabase/migrations/20261016120000_core.sql
    dir: 'migrations',
    frozen: (file: string) => FROZEN_MIGRATION.test(file),
    source: (file: string) => `supabase/migrations/${file.replace(FROZEN_MIGRATION, '')}`,
  },
];

type Manifest = {
  sourceCommit: string;
  files: Record<string, { source: string; sha256: string }>;
};

const sha256 = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex');

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );

const posix = (path: string): string => path.split(sep).join('/');

// Repository-relative path of every frozen copy, with the path it was copied from.
const copies = (): Array<{ path: string; source: string }> =>
  ROOTS.flatMap(({ dir, frozen, source }) =>
    walk(dir)
      .map((file) => ({ path: posix(file), file: posix(relative(dir, file)) }))
      .filter(({ file }) => frozen(file))
      .map(({ path, file }) => ({ path, source: source(file) })),
  ).sort((left, right) => left.path.localeCompare(right.path));

const readManifest = (): Manifest => JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;

const write = (): void => {
  const files = Object.fromEntries(
    copies().map(({ path, source }) => [path, { source, sha256: sha256(path) }]),
  );
  const manifest: Manifest = { sourceCommit: readManifest().sourceCommit, files };

  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
};

const check = (): string[] => {
  const manifest = readManifest();
  const changed = Object.entries(manifest.files)
    .filter(([path, entry]) => !existsSync(path) || sha256(path) !== entry.sha256)
    .map(
      ([path]) =>
        `${path}: differs from its fingerprint — frozen files are re-copied, never edited`,
    );
  const unlisted = copies()
    .filter(({ path }) => !(path in manifest.files))
    .map(({ path }) => `${path}: not in manifest.json`);

  return [...changed, ...unlisted];
};

if (process.argv.includes('--write')) {
  write();
} else {
  const problems = check();

  for (const problem of problems) {
    console.error(problem);
  }

  process.exitCode = problems.length > 0 ? 1 : 0;
}
