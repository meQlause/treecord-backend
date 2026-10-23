import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const posix = (path: string): string => path.replaceAll('\\', '/');
const FROZEN = posix(fileURLToPath(new URL('./src/generated/frozen/', import.meta.url)));
const FROZEN_SHARED = fileURLToPath(new URL('./src/generated/treecord-shared.ts', import.meta.url));

// docs/BE/testing.md §8: every *.rules.ts keeps 100 % of its branches; `npm run test:coverage` fails below that.
export default defineConfig({
  plugins: [
    {
      // ADR-002: the frozen attester imports @treecord/shared unedited; tsconfig.json `paths` says the same for tsc and
      // tsx. Only imports from the frozen folder: the chain tests also load treecord-backend, whose own
      // @treecord/shared is the whole package.
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
      include: ['src/**/*.rules.ts'],
      thresholds: { perFile: true, branches: 100 },
    },
  },
});
