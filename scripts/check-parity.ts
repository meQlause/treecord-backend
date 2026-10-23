// SR-2 path parity (docs/strict-rules.md): tests/ mirrors src/, and no test file lives inside src/.
// tests/unit/<p>/<name>.test.ts and tests/integration/<p>/<name>.test.ts must have src/<p>/<name>.ts.
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const TEST_FILE = /\.(test|spec)\.tsx?$/;
const MIRRORED_ROOTS = ['tests/unit', 'tests/integration'];
// Integration folders that test something other than one source file, so they have no mirror.
const NOT_MIRRORED = [
  'tests/integration/db/', // the migrations and their guarantees (migrations/, not src/)
  'tests/integration/chain/', // API + worker + anvil journeys across features
  'tests/integration/journey/', // the full-journey test (phases.md B8)
];
const REGRESSION_NAME = /^REG-\d{3}\.[a-z0-9-]+\.test\.ts$/;

const walk = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
      )
    : [];

const posix = (path: string): string => relative('.', path).split(sep).join('/');

const testsInSrc = walk('src')
  .map(posix)
  .filter((file) => TEST_FILE.test(file))
  .map((file) => `${file}: test file inside src/`);

const unmirrored = MIRRORED_ROOTS.flatMap((root) =>
  walk(root)
    .map(posix)
    .filter(
      (file) => TEST_FILE.test(file) && !NOT_MIRRORED.some((prefix) => file.startsWith(prefix)),
    )
    .filter((file) => !existsSync(file.replace(`${root}/`, 'src/').replace(TEST_FILE, '.ts')))
    .map((file) => `${file}: no src/ file at the mirrored path`),
);

const badRegressions = walk('tests/regression')
  .map(posix)
  .filter((file) => !REGRESSION_NAME.test(file.split('/').pop() ?? ''))
  .map((file) => `${file}: regression files are named REG-nnn.<slug>.test.ts`);

const problems = [...testsInSrc, ...unmirrored, ...badRegressions];

for (const problem of problems) {
  console.error(problem);
}

process.exitCode = problems.length > 0 ? 1 : 0;
