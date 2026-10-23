import type { Router } from 'express';
import type { Response } from 'supertest';
import { describe, expect, it } from 'vitest';

export const ROLES = ['donor', 'planter', 'auditor', 'operator'] as const;

export type Role = (typeof ROLES)[number];

export type Probe = {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  body?: object;
};

type MatrixEntry = {
  /** Anyone may call it: without a token it answers `ok` too. Otherwise no token is 401 missing_token. */
  public?: true;
  /** Roles the route's gate lets through; every other role answers 403 forbidden_role. */
  allowed: readonly Role[];
  /** The request each role sends (built per role when the record must be the caller's own), and the status an allowed
   *  role gets. */
  probe: Probe | ((role: Role) => Promise<Probe>);
  ok: number;
  /** For a route that reads or writes an owned record: builds one owned by someone else and returns the request for
   *  it. The caller (the first allowed role) gets 404 not_found, never 403 (ADR-008, NFR-004). */
  foreign?: () => Promise<Probe>;
};

/** Keyed by "METHOD /path" exactly as the router declares it, e.g. "GET /jobs/:id". */
export type AccessMatrix = Record<string, MatrixEntry>;

/** Sends a probe as a signed-in user holding the role. */
export type SendAs = (role: Role, probe: Probe) => Promise<Response>;

/** Sends a probe with no token. */
export type SendAnonymous = (probe: Probe) => Promise<Response>;

/** "METHOD /path" for every route the routers declare (a route's handlers each repeat its method). */
export const routesOf = (routers: Router[]): string[] => [
  ...new Set(
    routers.flatMap((router) =>
      router.stack.flatMap(({ route }) =>
        (route?.stack ?? []).map(({ method }) => `${method.toUpperCase()} ${route?.path}`),
      ),
    ),
  ),
];

/** docs/BE/testing.md §5 (ADR-008): one test per role per route, one signed out, and one foreign-record test per
 *  owned route. */
export const describeAccessMatrix = (
  matrix: AccessMatrix,
  send: SendAs,
  sendAnonymous: SendAnonymous,
): void => {
  describe('access matrix (ADR-008, NFR-004)', () => {
    describe.each(Object.entries(matrix))('%s', (_route, entry) => {
      it.each(ROLES)('as %s', async (role) => {
        const response = await send(
          role,
          typeof entry.probe === 'function' ? await entry.probe(role) : entry.probe,
        );

        if (entry.allowed.includes(role)) {
          expect(response.status).toBe(entry.ok);
        } else {
          expect(response.status).toBe(403);
          expect(response.body.error.code).toBe('forbidden_role');
        }
      });

      it('signed out', async () => {
        const response = await sendAnonymous(
          typeof entry.probe === 'function' ? await entry.probe('donor') : entry.probe,
        );

        if (entry.public === true) {
          expect(response.status).toBe(entry.ok);
        } else {
          expect(response.status).toBe(401);
          expect(response.body.error.code).toBe('missing_token');
        }
      });

      // only routes with an owned record get this test
      it.each(entry.foreign ? [entry.foreign] : [])(
        'a foreign record answers 404, never 403',
        async (foreign) => {
          const [caller = 'donor'] = entry.allowed;
          const response = await send(caller, await foreign());

          expect(response.status).toBe(404);
          expect(response.body.error.code).toBe('not_found');
        },
      );
    });
  });
};
