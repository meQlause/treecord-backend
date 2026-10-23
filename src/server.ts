import { createApp } from './app.js';
import { readConfig } from './config.js';
import { createChainClient } from './shared/chain/client.js';
import { createDatabase, pingDatabase } from './shared/db/database.js';
import { createLogger } from './shared/http/logger.js';

// NFR-008: a missing or malformed variable stops the process here, before anything listens.
const config = readConfig();
const logger = createLogger(config.LOG_LEVEL);
const database = createDatabase({
  url: config.DATABASE_URL,
  poolMax: config.DATABASE_POOL_MAX,
  onIdleError: (error) => logger.warn({ err: error }, 'postgres idle connection dropped'),
});
const chain = createChainClient(config.RPC_URL);

createApp({
  readiness: { database: () => pingDatabase(database), chain: () => chain.getBlockNumber() },
  logger,
}).listen(config.PORT);
