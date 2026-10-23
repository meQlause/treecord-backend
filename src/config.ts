import { z } from 'zod';

// docs/BE/be-stack.md §5. The only module that reads process.env (NFR-008, ADR-014).
const MAX_PORT = 65_535;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

// docs/phases.md D-6: resource limits are configuration; these are the planned values when unset.
const PLANNED_LIMITS = {
  jsonBodyLimitKb: 64,
  statementTimeoutMs: 5_000,
  rpcTimeoutMs: 10_000,
  s3TimeoutMs: 15_000,
  shutdownGraceMs: 10_000,
};

const positiveInt = z.coerce.number().int().positive();
const httpUrl = z.url({ protocol: /^https?$/ });

const configSchema = z.object({
  PORT: positiveInt.max(MAX_PORT),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_POOL_MAX: positiveInt,
  CHAIN_ID: positiveInt,
  RPC_URL: httpUrl,
  PRIVY_APP_ID: z.string().min(1),
  PRIVY_APP_SECRET: z.string().min(1),
  ATTESTER_PRIVATE_KEY: z.string().regex(PRIVATE_KEY, 'a 0x-prefixed 32-byte hex key'),
  S3_ENDPOINT: httpUrl,
  S3_PUBLIC_ENDPOINT: httpUrl,
  S3_REGION: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  WEB_ORIGIN: httpUrl,
  // campaigns §4: the start of every metadataURI, never the request's Host
  PUBLIC_API_URL: httpUrl,
  // ADR-007: wallet-signature sign-in exists only for the demo scripts and is off by default
  DEMO_WALLET_AUTH: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  JSON_BODY_LIMIT_KB: positiveInt.default(PLANNED_LIMITS.jsonBodyLimitKb),
  DATABASE_STATEMENT_TIMEOUT_MS: positiveInt.default(PLANNED_LIMITS.statementTimeoutMs),
  RPC_TIMEOUT_MS: positiveInt.default(PLANNED_LIMITS.rpcTimeoutMs),
  S3_TIMEOUT_MS: positiveInt.default(PLANNED_LIMITS.s3TimeoutMs),
  SHUTDOWN_GRACE_MS: positiveInt.default(PLANNED_LIMITS.shutdownGraceMs),
});

export type Config = z.infer<typeof configSchema>;

/** Parses the environment once; throws naming every missing or malformed variable. */
export const loadConfig = (env: Record<string, string | undefined>): Config => {
  const parsed = configSchema.safeParse(env);

  if (parsed.success) {
    return parsed.data;
  }

  const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);

  throw new Error(`Invalid environment — ${problems.join('; ')}`);
};

export const readConfig = (): Config => loadConfig(process.env);
