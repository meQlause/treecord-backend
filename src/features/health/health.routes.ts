import { Router } from 'express';

const HTTP = { ok: 200, serviceUnavailable: 503 } as const;

/** Each probe resolves when its dependency answers (ADR-017: PostgreSQL and the RPC). */
export type ReadinessProbes = {
  database: () => Promise<unknown>;
  chain: () => Promise<unknown>;
};

export const healthRouter = (probes: ReadinessProbes): Router =>
  Router()
    .get('/healthz', (_req, res) => {
      res.json({ status: 'ok' });
    })
    .get('/readyz', async (_req, res) => {
      const results = await Promise.allSettled([probes.database(), probes.chain()]);
      const ready = results.every((result) => result.status === 'fulfilled');

      res
        .status(ready ? HTTP.ok : HTTP.serviceUnavailable)
        .json({ status: ready ? 'ready' : 'not_ready' });
    });
