import { createApp } from './app.js';
import { readConfig } from './config.js';
import { authOptions, createRootContainer, privateRouters, publicRouters } from './container.js';
import { pingDatabase } from './shared/db/database.js';
import { shutdownGracefully } from './shutdown.js';

// NFR-008: a missing or malformed variable stops the process here, before anything listens.
const config = readConfig();
const container = createRootContainer(config);
const { logger, database, chain } = container.cradle;

const server = createApp({
  readiness: { database: () => pingDatabase(database), chain: () => chain.getBlockNumber() },
  logger,
  jsonBodyLimitKb: config.JSON_BODY_LIMIT_KB,
  auth: authOptions(container.cradle),
  publicRouters: publicRouters(container.cradle),
  privateRouters: privateRouters(container.cradle),
}).listen(config.PORT);

const stop = (signal: NodeJS.Signals): void => {
  logger.info({ signal }, 'shutting down');
  void shutdownGracefully(server, {
    graceMs: config.SHUTDOWN_GRACE_MS,
    closeResources: () => container.dispose(),
  }).then(() => process.exit(0));
};

process.once('SIGTERM', stop);
process.once('SIGINT', stop);
