// ADR-002: the frozen copies in src/generated/frozen/ match their SHA-256 fingerprints, and — when treecord-backend
// is checked out next to this repository — still match their source files there.
//   node scripts/check-frozen.ts           check
//   node scripts/check-frozen.ts --write   record the fingerprints after a deliberate re-copy
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const FROZEN = 'src/generated/frozen';
const MANIFEST = join(FROZEN, 'manifest.json');
const SOURCE_REPO = process.env['TREECORD_BACKEND_DIR'] ?? '../treecord-backend';
// Where each copied file lives in treecord-backend (SRS §2.6).
const SOURCE_DIR = 'packages/shared/src';

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

const copies = (): string[] =>
  walk(FROZEN)
    .map((file) => relative(FROZEN, file).split(sep).join('/'))
    .filter((file) => file !== 'manifest.json')
    .sort();

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
  const commit = sourceCommit();
  const files = Object.fromEntries(
    copies().map((file) => [
      file,
      { source: `${SOURCE_DIR}/${file}`, sha256: sha256(join(FROZEN, file)) },
    ]),
  );
  const manifest: Manifest = { sourceRepo: 'treecord-backend', sourceCommit: commit, files };

  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
};

const check = (): string[] => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
  const listed = Object.entries(manifest.files);
  const changed = listed
    .filter(
      ([file, entry]) =>
        !existsSync(join(FROZEN, file)) || sha256(join(FROZEN, file)) !== entry.sha256,
    )
    .map(
      ([file]) =>
        `${FROZEN}/${file}: differs from its fingerprint — frozen files are re-copied, never edited`,
    );
  const unlisted = copies()
    .filter((file) => !(file in manifest.files))
    .map((file) => `${FROZEN}/${file}: not in manifest.json`);
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
