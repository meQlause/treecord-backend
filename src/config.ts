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
  // ADR-020: empty on MinIO; the project id and a dash on Cloud Storage, where bucket names are global
  S3_BUCKET_PREFIX: z.string().default(''),
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

// ADR-021: the worker's own process (src/worker.ts). It shares the API's .env; the operator and relayer keys are
// the worker's only (ADR-014), and the API's schema ignores them.
const WORKER_DEFAULTS = {
  port: 8080,
  poolMax: 5,
  indexerPollMs: 4_000,
  indexerChunkBlocks: 2_000,
  indexerConfirmations: 2,
  indexerRescanBlocks: 5,
  relayerPollMs: 2_000,
  schedulerIntervalMs: 60_000,
};
const privateKey = z.string().regex(PRIVATE_KEY, 'a 0x-prefixed 32-byte hex key');
const count = z.coerce.number().int().min(0);

const workerConfigSchema = z
  .object({
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    // which loops this process runs; `relayer` includes the scheduled tasks, which also send transactions
    WORKER_MODE: z.enum(['all', 'indexer', 'relayer']).default('all'),
    // GET /health and GET /metrics
    WORKER_PORT: positiveInt.max(MAX_PORT).default(WORKER_DEFAULTS.port),
    RPC_URL: httpUrl,
    CHAIN_ID: positiveInt,
    OPERATOR_PRIVATE_KEY: privateKey,
    RELAYER_PRIVATE_KEY: privateKey,
    ATTESTER_PRIVATE_KEY: privateKey,
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    WORKER_DATABASE_POOL_MAX: positiveInt.default(WORKER_DEFAULTS.poolMax),
    S3_ENDPOINT: httpUrl,
    S3_PUBLIC_ENDPOINT: httpUrl,
    S3_REGION: z.string().min(1),
    S3_ACCESS_KEY: z.string().min(1),
    S3_SECRET_KEY: z.string().min(1),
    S3_BUCKET_PREFIX: z.string().default(''),
    S3_TIMEOUT_MS: positiveInt.default(PLANNED_LIMITS.s3TimeoutMs),
    // ADR-018: the mock is the default while the first environment is local
    MOCK_AI: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    AI_SERVICE_URL: httpUrl.optional(),
    AI_SERVICE_TOKEN: z.string().min(1).optional(),
    INDEXER_POLL_MS: positiveInt.default(WORKER_DEFAULTS.indexerPollMs),
    INDEXER_CHUNK_BLOCKS: positiveInt.default(WORKER_DEFAULTS.indexerChunkBlocks),
    INDEXER_CONFIRMATIONS: count.default(WORKER_DEFAULTS.indexerConfirmations),
    INDEXER_RESCAN_BLOCKS: count.default(WORKER_DEFAULTS.indexerRescanBlocks),
    // overrides the deploy block from the frozen addresses, for example to skip history
    INDEXER_START_BLOCK: count.optional(),
    RELAYER_POLL_MS: positiveInt.default(WORKER_DEFAULTS.relayerPollMs),
    SCHEDULER_INTERVAL_MS: positiveInt.default(WORKER_DEFAULTS.schedulerIntervalMs),
  })
  .superRefine((env, context) => {
    if (env.MOCK_AI) {
      return;
    }

    for (const name of ['AI_SERVICE_URL', 'AI_SERVICE_TOKEN'] as const) {
      if (!env[name]) {
        context.addIssue({
          code: 'custom',
          path: [name],
          message: 'is required when MOCK_AI is false',
        });
      }
    }
  });

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

/** NFR-008: parses the worker's environment once; throws naming every missing or malformed variable. */
const loadWorkerConfig = (env: Record<string, string | undefined>): WorkerConfig => {
  const parsed = workerConfigSchema.safeParse(env);

  if (parsed.success) {
    return parsed.data;
  }

  const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);

  throw new Error(`Invalid worker environment — ${problems.join('; ')}`);
};

export const readWorkerConfig = (): WorkerConfig => loadWorkerConfig(process.env);
