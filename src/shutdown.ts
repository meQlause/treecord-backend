import type { Server } from 'node:http';

type ShutdownOptions = {
  /** SHUTDOWN_GRACE_MS (phases.md D-6): how long in-flight requests get before their sockets are cut. */
  graceMs: number;
  /** The database pool and anything else holding the process open. */
  closeResources: () => Promise<void>;
};

/** docs/operations.md §3: stop accepting, finish in-flight requests within the grace period, close the pool. */
export const shutdownGracefully = async (
  server: Server,
  { graceMs, closeResources }: ShutdownOptions,
): Promise<void> => {
  const closed = new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  const cut = setTimeout(() => server.closeAllConnections(), graceMs);

  server.closeIdleConnections();
  await closed;
  clearTimeout(cut);
  await closeResources();
};
