import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const posix = (path: string): string => path.replaceAll('\\', '/');
const FROZEN = posix(fileURLToPath(new URL('./src/generated/frozen/', import.meta.url)));
const FROZEN_SHARED = fileURLToPath(new URL('./src/generated/treecord-shared.ts', import.meta.url));

// docs/BE/testing.md §8: every *.rules.ts keeps 100 % of its branches, every *.service.ts 80 % of its lines, the
// backend 80 % of its lines, over the whole suite; `npm run test:coverage` fails below any of them.
export default defineConfig({
  plugins: [
    {
      // ADR-002: the frozen attester imports @treecord/shared unedited; tsconfig.json `paths` says the same for tsc and
      // tsx. Only imports from the frozen folder.
      name: 'frozen-treecord-shared',
      enforce: 'pre',
      resolveId: (source, importer) =>
        source === '@treecord/shared' &&
        importer !== undefined &&
        posix(importer).startsWith(FROZEN)
          ? FROZEN_SHARED
          : null,
    },
  ],
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // the frozen copies and generated types are verified by fingerprint, not by tests (ADR-002)
      exclude: ['src/generated/**'],
      thresholds: {
        lines: 80,
        'src/**/*.rules.ts': { branches: 100, perFile: true },
        'src/**/*.service.ts': { lines: 80, perFile: true },
      },
    },
  },
});
