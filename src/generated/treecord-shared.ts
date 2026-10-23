// ADR-002: what the frozen attester (src/generated/frozen/attester.ts) imports as `@treecord/shared`, resolved to the
// frozen copies of packages/shared so the copied file stays byte-identical. Mapped in tsconfig.json and vitest.config.ts.
export * from './frozen/constants.js';
export * from './frozen/eip712.js';
