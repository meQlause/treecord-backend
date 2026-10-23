import { createApp } from './app.js';
import { readConfig } from './config.js';
import { createChainClient } from './shared/chain/client.js';
import { createDatabase, pingDatabase } from './shared/db/database.js';

// NFR-008: a missing or malformed variable stops the process here, before anything listens.
const config = readConfig();
// ponytail: console until the pino logger lands (B0 request-id criterion), then the logger
const database = createDatabase({
  url: config.DATABASE_URL,
  poolMax: config.DATABASE_POOL_MAX,
  onIdleError: (error) => console.error('postgres idle connection dropped', error.message),
});
const chain = createChainClient(config.RPC_URL);

createApp({
  readiness: { database: () => pingDatabase(database), chain: () => chain.getBlockNumber() },
  logUnexpected: (error, requestId) => console.error('unexpected error', requestId, error),
}).listen(config.PORT);
