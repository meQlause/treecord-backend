import { calculateJwkThumbprint } from 'jose';
import { sql } from 'kysely';
import { generateKeyPairSync } from 'node:crypto';
import type { DatabaseClient } from '../../src/shared/db/database.js';
import { ISSUED_TX, PLANTING_CAMPAIGN } from '../fixtures/matrix.js';
import { aJob, CAMPAIGN as TREE_CAMPAIGN, TREE_ID } from '../fixtures/mirror.js';
import type { Probe, Role } from './access-matrix.js';

type Owner = Role | 'other';

/** What every probe needs: the database (read at call time, since the matrix is declared before it starts), the
 *  profile ids by role, and a hash no other probe has announced. */
type Context = {
  database: () => DatabaseClient;
  profileOf: ReadonlyMap<Owner, string>;
  nextSha: () => string;
};

const firstId = async (context: Context, query: ReturnType<typeof sql<{ id: string }>>) =>
  (await query.execute(context.database())).rows[0]?.id ?? '';

/** A fresh public P-256 key, as a browser registers it. */
const publicKey = () => {
  const { kty, crv, x, y } = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({
    format: 'jwk',
  });

  return { kty, crv, x, y } as { kty: string; crv: string; x: string; y: string };
};

const deviceOf = async (context: Context, owner: Owner): Promise<Probe> => {
  const key = publicKey();
  const id = await firstId(
    context,
    sql`insert into public.devices (profile_id, public_key_jwk, thumbprint, label)
      values (${context.profileOf.get(owner)}, ${JSON.stringify(key)}::jsonb,
        ${await calculateJwkThumbprint(key, 'sha256')}, 'Matrix') returning id`,
  );

  return { method: 'delete', path: `/api/v1/devices/${id}` };
};

// a queued planting announced by `owner`, and the matching signed body; the matrix has no MinIO, so its owner gets
// past the role gate and ownership to 503 (MinIO unreachable, ADR-010)
const submissionOf = async (context: Context, owner: Owner): Promise<Probe> => {
  const sha256 = context.nextSha();
  const id = await firstId(
    context,
    sql`insert into public.submissions (profile_id, campaign_address, kind, milestone, slot_id, video_sha256,
        video_path, status)
      values (${context.profileOf.get(owner)}, ${PLANTING_CAMPAIGN}, 'PLANTED', 0, 1, ${sha256}, 'matrix.mp4',
        'queued') returning id`,
  );

  return {
    method: 'post',
    path: `/api/v1/evidence/${id}/submit`,
    body: {
      payload: {
        v: 1,
        kind: 'PLANTED',
        campaign: PLANTING_CAMPAIGN,
        slotId: '1',
        treeId: null,
        milestone: 0,
        videoSha256: sha256,
        lat: 0,
        lon: 0,
        acc: 5,
        capturedAt: '2026-10-23T03:00:00.000Z',
        challenge: null,
        deviceKey: 'x'.repeat(43),
      },
      canonical: '{}',
      signature: 'A'.repeat(86),
    },
  };
};

// a planting waiting for review on PLANTING_CAMPAIGN, on its own slot each call (one live planting per slot)
const plantingInReview = async (context: Context): Promise<string> => {
  const sha256 = context.nextSha();

  return firstId(
    context,
    sql`insert into public.submissions (profile_id, campaign_address, kind, milestone, slot_id, video_sha256, status)
      values (${context.profileOf.get('other')}, ${PLANTING_CAMPAIGN}, 'PLANTED', 0, ${100 + Number(sha256)},
        ${sha256.replaceAll('0', 'f')}, 'needs_review') returning id`,
  );
};

// an open audit session on tree 3001's campaign, owned by `owner`
const sessionOf = async (context: Context, owner: Owner): Promise<Probe> => {
  const id = await firstId(
    context,
    sql`insert into public.audit_sessions (auditor_profile_id, campaign_address, seed_block_number, seed_block_hash,
        seed, population_tree_ids, sample_size)
      values (${context.profileOf.get(owner)}, ${TREE_CAMPAIGN}, 1, ${ISSUED_TX}, ${ISSUED_TX},
        array[${TREE_ID}]::bigint[], 1) returning id`,
  );

  return { method: 'get', path: `/api/v1/audit/sessions/${id}` };
};

// an open session on tree 3001 alone, its finding recorded, so it may also close
const reviewedSessionOf = async (context: Context, owner: Owner): Promise<string> => {
  const { path } = await sessionOf(context, owner);

  await sql`insert into public.audit_samples (session_id, position, tree_id, finding, recorded_at)
    values (${path.split('/').at(-1) ?? ''}, 0, ${TREE_ID}, 'ok', now())`.execute(
    context.database(),
  );

  return path;
};

/** The records the access matrix (tests/integration/container.test.ts) probes, each owned by a role or by `other`. */
export const matrixProbes = (
  database: () => DatabaseClient,
  profileOf: ReadonlyMap<Owner, string>,
) => {
  let announced = 0;
  const context: Context = {
    database,
    profileOf,
    nextSha: () => {
      announced += 1;

      return String(announced).padStart(64, '0');
    },
  };

  return {
    publicKey,
    nextSha: context.nextSha,
    deviceOf: (owner: Owner) => deviceOf(context, owner),
    submissionOf: (owner: Owner) => submissionOf(context, owner),
    // the same queued submission, read back by its owner
    submissionReadOf: async (owner: Owner): Promise<Probe> => ({
      method: 'get',
      path: (await submissionOf(context, owner)).path.replace(/\/submit$/, ''),
    }),
    plantingInReview: () => plantingInReview(context),
    sessionOf: (owner: Owner) => sessionOf(context, owner),
    auditWrite:
      (action: 'findings' | 'close' | 'challenges', body: object) =>
      async (owner: Owner): Promise<Probe> => ({
        method: 'post',
        path: `${await reviewedSessionOf(context, owner)}/${action}`,
        body,
      }),
    reportOf: async (owner: Owner): Promise<Probe> => ({
      method: 'get',
      path: `${await reviewedSessionOf(context, owner)}/report`,
    }),
    jobOf: async (owner: Owner): Promise<Probe> => ({
      method: 'get',
      path: `/api/v1/jobs/${await aJob(database(), profileOf.get(owner) ?? null)}`,
    }),
  };
};
