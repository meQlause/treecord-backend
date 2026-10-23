import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// docs/BE/testing.md §8: every *.rules.ts keeps 100 % of its branches; `npm run test:coverage` fails below that.
export default defineConfig({
  // ADR-002: the frozen attester imports @treecord/shared unedited; tsconfig.json `paths` says the same for tsc and tsx
  resolve: {
    alias: {
      '@treecord/shared': fileURLToPath(
        new URL('./src/generated/treecord-shared.ts', import.meta.url),
      ),
    },
  },
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.rules.ts'],
      thresholds: { perFile: true, branches: 100 },
    },
  },
});
