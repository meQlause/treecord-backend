// ADR-002, ADR-019: the frozen copies — src/generated/frozen/ and the nine migrations/1nn_*.sql — match their SHA-256
// fingerprints, and, when treecord-backend is checked out next to this repository, still match their source files.
//   node scripts/check-frozen.ts           check
//   node scripts/check-frozen.ts --write   record the fingerprints after a deliberate re-copy
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const FROZEN = 'src/generated/frozen';
const MANIFEST = join(FROZEN, 'manifest.json');
const SOURCE_REPO = process.env['TREECORD_BACKEND_DIR'] ?? '../treecord-backend';
const FROZEN_MIGRATION = /^1\d\d_/;
// Each frozen root, which of its files are frozen, and where each lives in treecord-backend (SRS §2.6).
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
  sourceRepo: string;
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

// Repository-relative path of every frozen copy, with the treecord-backend path it was copied from.
const copies = (): Array<{ path: string; source: string }> =>
  ROOTS.flatMap(({ dir, frozen, source }) =>
    walk(dir)
      .map((file) => ({ path: posix(file), file: posix(relative(dir, file)) }))
      .filter(({ file }) => frozen(file))
      .map(({ path, file }) => ({ path, source: source(file) })),
  ).sort((left, right) => left.path.localeCompare(right.path));

// The source commit, read from .git directly: a loose ref, or packed-refs after `git gc`.
const sourceCommit = (): string => {
  const head = readFileSync(join(SOURCE_REPO, '.git', 'HEAD'), 'utf8').trim();
  const ref = head.startsWith('ref: ') ? head.slice('ref: '.length) : undefined;

  if (ref === undefined) {
    return head;
  }

  const loose = join(SOURCE_REPO, '.git', ref);

  if (existsSync(loose)) {
    return readFileSync(loose, 'utf8').trim();
  }

  const packed = readFileSync(join(SOURCE_REPO, '.git', 'packed-refs'), 'utf8');

  return (
    packed
      .split('\n')
      .find((line) => line.endsWith(` ${ref}`))
      ?.split(' ')[0] ?? 'unknown'
  );
};

const write = (): void => {
  const files = Object.fromEntries(
    copies().map(({ path, source }) => [path, { source, sha256: sha256(path) }]),
  );
  const manifest: Manifest = {
    sourceRepo: 'treecord-backend',
    sourceCommit: sourceCommit(),
    files,
  };

  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
};

const check = (): string[] => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
  const listed = Object.entries(manifest.files);
  const changed = listed
    .filter(([path, entry]) => !existsSync(path) || sha256(path) !== entry.sha256)
    .map(
      ([path]) =>
        `${path}: differs from its fingerprint — frozen files are re-copied, never edited`,
    );
  const unlisted = copies()
    .filter(({ path }) => !(path in manifest.files))
    .map(({ path }) => `${path}: not in manifest.json`);
  const upstream = existsSync(SOURCE_REPO)
    ? listed
        .filter(([, entry]) => {
          const source = join(SOURCE_REPO, entry.source);

          return !existsSync(source) || sha256(source) !== entry.sha256;
        })
        .map(
          ([, entry]) =>
            `${SOURCE_REPO}/${entry.source}: changed upstream — re-copy and run --write`,
        )
    : [];

  return [...changed, ...unlisted, ...upstream];
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
