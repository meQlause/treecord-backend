import { randomInt } from 'node:crypto';
import { bytesToHex, type Hex } from 'viem';
import {
  AUDIT_SAMPLE_ALGORITHM,
  auditSeed,
  reportHash,
  sampleTreeIds,
  type JsonValue,
} from '../../generated/frozen/audit.js';
import type { DatabaseClient } from '../../shared/db/database.js';
import type { Storage } from '../../shared/storage/storage.js';
import { toTreeBundle } from './audit.bundle.js';
import { DomainError } from '../../shared/errors.js';
import { toChallenge, toReproduction, toSession } from './audit.mapper.js';
import { auditRepository, type SampleRow, type SessionRow } from './audit.repository.js';
import { buildReport, challengeRefusal, missingFindings, type Finding } from './audit.rules.js';
import type { FindingInput, OpenSessionInput } from './audit.schema.js';

type Auditor = { id: string };

type AuditDependencies = {
  database: DatabaseClient;
  /** Read from the chain, never the mirror (FR-182). */
  latestBlock: () => Promise<{ number: string; hash: Hex }>;
  /** The server clock: findings, the close and challenge expiry. */
  clock: () => Date;
  /** The session id, made before the insert because the seed needs it (§2). */
  newId: () => string;
  /** CSPRNG bytes: the salt sealing each close's notes (FR-191). */
  randomBytes: (count: number) => Uint8Array;
  /** §4: presigned evidence links and the stored video's hash. */
  storage: Pick<Storage, 'presignGet' | 'sha256Of'>;
};

const SALT_BYTES = 32;
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_LENGTH = 4;
const ONE_OPEN_PER_TREE = 'challenges_one_open_per_tree';

/** §6, NFR-052: four characters, each drawn with crypto.randomInt, never Math.random; codes need not be unique. */
const challengeCode = (): string =>
  Array.from({ length: CODE_LENGTH }, () =>
    CODE_ALPHABET.charAt(randomInt(CODE_ALPHABET.length)),
  ).join('');

/** §7, §8: the report body, read from what close stored and never rebuilt (FR-201); all null while open. */
const storedReport = (session: SessionRow) => ({
  sessionId: session.id,
  status: session.status,
  closedAt: session.closed_at?.toISOString() ?? null,
  campaign: { address: session.campaign_address, title: session.title },
  reportHash: session.report_hash,
  report: session.report,
  notes: session.report_notes,
});

const sampleFacts = (
  row: Pick<SampleRow, 'position' | 'tree_id' | 'finding' | 'notes' | 'recorded_at'>,
) => ({
  position: row.position,
  treeId: row.tree_id,
  finding: row.finding as Finding | null,
  notes: row.notes,
  recordedAt: row.recorded_at?.toISOString() ?? null,
});

/** §2, FR-182–FR-184: the latest block first, outside the transaction; then the population, seed and sample. */
const openOf =
  ({ database, latestBlock, newId }: AuditDependencies) =>
  async (auditor: Auditor, { campaign, sampleSize }: OpenSessionInput): Promise<string> => {
    const block = await latestBlock();
    const id = newId().toLowerCase();

    await database.transaction().execute(async (trx) => {
      const writes = auditRepository(trx);

      if (!(await writes.campaignExists(campaign))) {
        throw new DomainError('validation_error', [
          { path: 'campaign', message: 'Select an indexed campaign.' },
        ]);
      }

      const population = await writes.population(campaign);

      if (population.length === 0) {
        throw new DomainError('no_trees');
      }

      const seed = auditSeed(id, block.hash);
      const sample = sampleTreeIds(population.map(BigInt), seed, sampleSize).map(String);

      await writes.insertSession({
        id,
        auditorId: auditor.id,
        campaign,
        block,
        seed,
        population,
        sample,
      });
    });

    return id;
  };

/** §5, FR-197: replaces one sampled tree's finding, under a share lock so the close cannot slip in between. */
const recordOf =
  ({ database, clock }: AuditDependencies) =>
  async (auditor: Auditor, id: string, { treeId, finding, notes }: FindingInput) =>
    database.transaction().execute(async (trx) => {
      const writes = auditRepository(trx);
      const status = await writes.lockedStatus(id, auditor.id, 'share');

      if (status === undefined) {
        throw new DomainError('not_found');
      }

      if (status === 'closed') {
        throw new DomainError('session_closed');
      }

      const row = await writes.recordFinding(id, treeId, { finding, notes, recordedAt: clock() });

      if (row === undefined) {
        throw new DomainError('not_found');
      }

      return sampleFacts(row);
    });

/** §7, FR-190–FR-192, ADR-004: one transaction under the session's update lock; a closed session answers its stored
 *  report, never a second build. False when it was already closed. */
const closeOf =
  ({ database, clock, randomBytes }: AuditDependencies) =>
  async (auditor: Auditor, id: string, summary: string): Promise<boolean> =>
    database.transaction().execute(async (trx) => {
      const writes = auditRepository(trx);
      const status = await writes.lockedStatus(id, auditor.id, 'update');

      if (status === undefined) {
        throw new DomainError('not_found');
      }

      if (status === 'closed') {
        return false;
      }

      const session = (await writes.session(id, auditor.id)) as SessionRow;
      const samples = (await writes.samples(id)).map(sampleFacts);
      const missing = missingFindings(samples);

      if (missing.length > 0) {
        throw new DomainError('findings_incomplete', { missing });
      }

      const closedAt = clock();
      const built = buildReport({
        session: {
          id,
          campaign: session.campaign_address,
          blockNumber: session.seed_block_number,
          blockHash: session.seed_block_hash,
          seed: session.seed,
          population: session.population,
          sampleSize: session.sample_size,
        },
        auditor: { profileId: auditor.id, wallet: await writes.walletOf(auditor.id) },
        samples,
        challenges: (await writes.issuedChallenges(id)).map((row) => ({
          treeId: row.tree_id,
          code: row.code,
          issuedAt: row.created_at.toISOString(),
          expiresAt: row.expires_at.toISOString(),
          fulfilledSubmissionId: row.fulfilled_submission_id,
        })),
        closedAt: closedAt.toISOString(),
        salt: bytesToHex(randomBytes(SALT_BYTES)),
        summary,
      });

      await writes.close(id, { closedAt, ...built });

      return true;
    });

/** §6: what a challenge is judged on, read under the session's lock. */
const challengeFacts = async (
  writes: ReturnType<typeof auditRepository>,
  { id, treeId, status }: { id: string; treeId: string; status: string },
) => {
  const target = await writes.challengeTarget(id, treeId);
  const open = await writes.openChallenge(treeId);

  return {
    sessionStatus: status,
    sampled: target?.sampled ?? false,
    openChallenge:
      open === undefined ? null : { id: open.id, expiresAt: open.expires_at.toISOString() },
    treeStatus: target?.status ?? 'unknown',
  };
};

/** §6, FR-198: judged under the session's share lock in the REG-007 order, then inserted; the exclusion constraint
 *  makes "one open challenge per tree" true when two arrive at once, and its 23P01 is re-read for the details. */
const challengeOf =
  ({ database, clock }: AuditDependencies) =>
  async (auditor: Auditor, id: string, treeId: string) => {
    try {
      const row = await database.transaction().execute(async (trx) => {
        const writes = auditRepository(trx);
        const status = await writes.lockedStatus(id, auditor.id, 'share');

        if (status === undefined) {
          throw new DomainError('not_found');
        }

        const refusal = challengeRefusal(await challengeFacts(writes, { id, treeId, status }));

        if (refusal !== null) {
          throw new DomainError(refusal.code, 'details' in refusal ? refusal.details : undefined);
        }

        return writes.insertChallenge({
          sessionId: id,
          treeId,
          code: challengeCode(),
          issuedBy: auditor.id,
        });
      });

      if (row === undefined) {
        throw new Error(`challenge for tree ${treeId} was not inserted`);
      }

      return { treeId, ...toChallenge(row, clock()) };
    } catch (error) {
      if ((error as { constraint?: unknown }).constraint !== ONE_OPEN_PER_TREE) {
        throw error;
      }

      const open = await auditRepository(database).openChallenge(treeId);

      throw new DomainError(
        'challenge_active',
        open === undefined
          ? undefined
          : { challengeId: open.id, expiresAt: open.expires_at.toISOString() },
      );
    }
  };

/** §4, FR-193–FR-196, NFR-053: ownership and the sample first, refusals unlogged; then the access row, committed on
 *  its own before any evidence is read; then the bundle. Every read, a refetch included, logs again. */
const treeOf =
  ({ database, storage, clock }: AuditDependencies) =>
  async (auditor: Auditor, id: string, treeId: string) => {
    const repository = auditRepository(database);
    const session = await repository.session(id, auditor.id);
    const sample = session === undefined ? undefined : await repository.sampleOf(id, treeId);

    if (session === undefined || sample === undefined) {
      throw new DomainError('not_found');
    }

    await repository.logAccess(id, auditor.id, `tree:${treeId}`);

    const tree = await repository.bundleTree(treeId);
    const [submissions, events, payouts, forfeited, challenges, open] = await Promise.all([
      repository.bundleSubmissions(tree),
      repository.events(treeId),
      repository.payouts(treeId),
      repository.forfeitedMilestones(treeId),
      repository.challenges(id),
      repository.openChallenge(treeId),
    ]);

    return toTreeBundle(
      storage,
      { session, sample, tree, submissions, events, payouts, forfeited, challenges, open },
      clock(),
    );
  };

/** docs/BE/features/audit.md: an auditor's sessions, each a frozen, reproducible sample of one campaign's trees. */
export const createAuditService = (dependencies: AuditDependencies) => {
  const repository = auditRepository(dependencies.database);
  const open = openOf(dependencies);
  const record = recordOf(dependencies);
  const close = closeOf(dependencies);
  const challenge = challengeOf(dependencies);
  const tree = treeOf(dependencies);

  /** The caller's own session; anyone else's answers as unknown (ADR-008, REG-005). */
  const ownSession = async (auditor: Auditor, id: string): Promise<SessionRow> => {
    const session = await repository.session(id, auditor.id);

    if (session === undefined) {
      throw new DomainError('not_found');
    }

    return session;
  };

  /** §3: the session with every sample card. */
  const sessionOf = async (auditor: Auditor, id: string) => {
    const session = await ownSession(auditor, id);
    const [samples, challenges] = await Promise.all([
      repository.samples(id),
      repository.challenges(id),
    ]);

    return toSession(session, { samples, challenges, now: dependencies.clock() });
  };

  return {
    open: async (auditor: Auditor, input: OpenSessionInput) =>
      sessionOf(auditor, await open(auditor, input)),
    session: sessionOf,
    record,
    challenge,
    tree,

    close: async (auditor: Auditor, id: string, summary: string) => {
      const built = await close(auditor, id, summary);
      const body = storedReport(await ownSession(auditor, id));

      return built ? body : { ...body, idempotent: true };
    },

    /** §9, FR-203–FR-205: public; the server's own checks with the same shared functions the browser copies. A
     *  mismatch is reported, never regenerated (FR-204). */
    reproduce: async (id: string) => {
      const session = await repository.publicSession(id);

      if (session === undefined) {
        throw new DomainError('not_found');
      }

      const seed = auditSeed(session.id, session.seed_block_hash as Hex);
      const recomputedSample = sampleTreeIds(
        session.population.map(BigInt),
        seed,
        session.sample_size,
      ).map(String);

      return toReproduction(
        session,
        {
          seedMatches: seed === session.seed,
          recomputedSample,
          sampleMatches: recomputedSample.join() === session.sample.join(),
          reportMatches:
            session.report_hash === null
              ? null
              : reportHash(session.report as JsonValue) === session.report_hash,
        },
        AUDIT_SAMPLE_ALGORITHM,
      );
    },

    /** §8: the stored report with the private notes, for the owner only. */
    report: async (auditor: Auditor, id: string) => storedReport(await ownSession(auditor, id)),
  };
};

/** evidence §4 (REG-005, DN-8): an auditor reads a submission only when one of their sessions sampled its tree, and
 *  the read is logged against that session before the body is built. False for anyone else. */
export const auditorRead = async (
  database: DatabaseClient,
  { auditorId, treeId, resource }: { auditorId: string; treeId: string | null; resource: string },
): Promise<boolean> => {
  const repository = auditRepository(database);
  const session = treeId === null ? undefined : await repository.samplingSession(auditorId, treeId);

  if (session === undefined) {
    return false;
  }

  await repository.logAccess(session, auditorId, resource);

  return true;
};
