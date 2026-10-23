import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DomainError, ERROR_REGISTRY } from '../../../../src/shared/errors.js';
import { errorHandler, notFound } from '../../../../src/shared/http/error-handler.js';
import { requestId } from '../../../../src/shared/http/request-id.js';
import { testApp } from '../../../helpers/app.js';

// docs/error-handling.md §3 — one status per code, exactly these 40 codes.
const REGISTRY = {
  validation_error: 400,
  invalid_json: 400,
  invalid_path: 400,
  invalid_cursor: 400,
  invalid_idempotency_key: 400,
  agreement_required: 400,
  payload_mismatch: 400,
  missing_token: 401,
  invalid_token: 401,
  forbidden_role: 403,
  role_locked: 403,
  wallet_missing: 403,
  not_contributor: 403,
  not_found: 404,
  wallet_already_linked: 409,
  idempotency_key_reused: 409,
  device_limit_reached: 409,
  device_already_registered: 409,
  campaign_not_active: 409,
  claim_window_closed: 409,
  not_enough_slots: 409,
  planter_cap_exceeded: 409,
  not_in_review: 409,
  cannot_attest: 409,
  tree_not_flaggable: 409,
  flag_not_open: 409,
  flag_resolution_pending: 409,
  no_trees: 409,
  session_closed: 409,
  challenge_active: 409,
  tree_not_alive: 409,
  findings_incomplete: 409,
  estimate_locked: 409,
  species_unknown: 409,
  campaign_not_issuable: 409,
  registry_retirement_done: 409,
  video_not_uploaded: 409,
  precheck_failed: 422,
  internal_error: 500,
  service_unavailable: 503,
};

const appWithLimit = () => testApp({ jsonBodyLimitKb: 1 });

const appThrowing = (error: unknown, logUnexpected = vi.fn()) =>
  express()
    .use(requestId)
    .get('/throws', async () => {
      throw error;
    })
    .use(notFound)
    .use(errorHandler({ logUnexpected }));

describe('error envelope — docs/error-handling.md §1–§3', () => {
  it('the registry holds every §3 code with its one status', () => {
    expect(
      Object.fromEntries(
        Object.entries(ERROR_REGISTRY).map(([code, { status }]) => [code, status]),
      ),
    ).toEqual(REGISTRY);
  });

  it('an unknown route answers 404 not_found in the envelope', async () => {
    const response = await request(appWithLimit()).get('/nowhere').expect(404);

    expect(response.body).toEqual({
      error: {
        code: 'not_found',
        message: 'Not found · Page not found',
        requestId: expect.any(String),
      },
    });
    expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
  });

  it('a thrown domain error answers its registry status, with the §4 sentence filled from details', async () => {
    const error = new DomainError('planter_cap_exceeded', { remaining: 1, cap: 3 });
    const response = await request(appThrowing(error)).get('/throws').expect(409);

    expect(response.body.error).toEqual({
      code: 'planter_cap_exceeded',
      message: 'You can claim at most 1 more slots in this campaign',
      details: { remaining: 1, cap: 3 },
      requestId: expect.any(String),
    });
  });

  it('a schema failure answers 400 validation_error with details[] of path and message', async () => {
    const parsed = z.strictObject({ count: z.number() }).safeParse({ count: 'three', extra: true });
    const response = await request(appThrowing(parsed.error)).get('/throws').expect(400);

    expect(response.body.error.code).toBe('validation_error');
    expect(response.body.error.details).toEqual([
      { path: 'count', message: expect.any(String) },
      { path: 'extra', message: expect.stringContaining('extra') },
    ]);
  });

  it('any other throw answers 500 internal_error with no stack, SQL or driver text, and is logged', async () => {
    const logUnexpected = vi.fn();
    const leak = new Error('relation "profiles" does not exist at Parser.parseErrorMessage');
    const response = await request(appThrowing(leak, logUnexpected)).get('/throws').expect(500);

    expect(response.body).toEqual({
      error: {
        code: 'internal_error',
        message: 'Could not load this page · Your inputs and local records are unchanged.',
        requestId: expect.any(String),
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/profiles|Parser|stack/);
    expect(logUnexpected).toHaveBeenCalledWith(leak, response.body.error.requestId);
  });

  it('a body that is not JSON answers 400 invalid_json', async () => {
    const response = await request(appWithLimit())
      .post('/api/v1/anything')
      .set('Content-Type', 'application/json')
      .send('{"kind": ')
      .expect(400);

    expect(response.body.error.code).toBe('invalid_json');
  });

  it('a body over the JSON limit answers 400 validation_error, never 500 (D-6)', async () => {
    const response = await request(appWithLimit())
      .post('/api/v1/anything')
      .send({ padding: 'x'.repeat(2048) })
      .expect(400);

    expect(response.body.error.code).toBe('validation_error');
  });
});
