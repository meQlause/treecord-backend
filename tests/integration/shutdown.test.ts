import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { shutdownGracefully } from '../../src/shutdown.js';

const SLACK_MS = 500;

const listening = async (routeMs: number): Promise<{ server: Server; port: number }> => {
  const app = express().get('/slow', (_req, res) => {
    setTimeout(() => res.json({ done: true }), routeMs);
  });
  const server = createServer(app);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return { server, port: (server.address() as AddressInfo).port };
};

// Resolves with the status, or with the socket error code when the connection fails.
const get = (port: number): Promise<number | string> =>
  new Promise((resolve) => {
    httpRequest({ host: '127.0.0.1', port, path: '/slow', agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    })
      .on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message))
      .end();
  });

const pause = (millis: number) => new Promise((resolve) => setTimeout(resolve, millis));

describe('graceful shutdown — docs/operations.md §3, phases.md D-6', () => {
  it('lets an in-flight request finish, refuses new connections, then closes the pool', async () => {
    const { server, port } = await listening(300);
    const closeResources = vi.fn(async () => undefined);
    const inFlight = get(port);

    await pause(50);

    const started = performance.now();
    const shutdown = shutdownGracefully(server, { graceMs: 2_000, closeResources });

    expect(await get(port)).toBe('ECONNREFUSED');
    expect(await inFlight).toBe(200);
    await shutdown;
    expect(closeResources).toHaveBeenCalledOnce();
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('cuts a request that outlasts the grace period, so the process still exits in time', async () => {
    const { server, port } = await listening(5_000);
    const closeResources = vi.fn(async () => undefined);
    const inFlight = get(port);

    await pause(50);

    const started = performance.now();

    await shutdownGracefully(server, { graceMs: 300, closeResources });

    expect(performance.now() - started).toBeLessThan(300 + SLACK_MS);
    expect(await inFlight).toBe('ECONNRESET');
    expect(closeResources).toHaveBeenCalledOnce();
  });
});
