import { defineConfig } from 'vitest/config';

// docs/BE/testing.md §8: every *.rules.ts keeps 100 % of its branches; `npm run test:coverage` fails below that.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.rules.ts'],
      thresholds: { perFile: true, branches: 100 },
    },
  },
});
