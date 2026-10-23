import type { Hex } from 'viem';
import { auditSeed, sampleTreeIds } from '../../generated/frozen/audit.js';
import type { DatabaseClient } from '../../shared/db/database.js';
import { DomainError } from '../../shared/errors.js';
import { toSession } from './audit.mapper.js';
import { auditRepository } from './audit.repository.js';
import type { OpenSessionInput } from './audit.schema.js';

type Auditor = { id: string };

type AuditDependencies = {
  database: DatabaseClient;
  /** Read from the chain, never the mirror (FR-182). */
  latestBlock: () => Promise<{ number: string; hash: Hex }>;
  /** The server clock: challenge expiry. */
  clock: () => Date;
  /** The session id, made before the insert because the seed needs it (§2). */
  newId: () => string;
};

/** docs/BE/features/audit.md: an auditor's sessions, each a frozen, reproducible sample of one campaign's trees. */
export const createAuditService = ({ database, latestBlock, clock, newId }: AuditDependencies) => {
  const repository = auditRepository(database);

  /** §3: the caller's own session; anyone else's answers as unknown (ADR-008, REG-005). */
  const sessionOf = async (auditor: Auditor, id: string) => {
    const session = await repository.session(id, auditor.id);

    if (session === undefined) {
      throw new DomainError('not_found');
    }

    const [samples, challenges] = await Promise.all([
      repository.samples(id),
      repository.challenges(id),
    ]);

    return toSession(session, { samples, challenges, now: clock() });
  };

  return {
    /** §2, FR-182–FR-184: the latest block first, outside the transaction; then the population, seed and sample. */
    open: async (auditor: Auditor, { campaign, sampleSize }: OpenSessionInput) => {
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

      return sessionOf(auditor, id);
    },

    session: sessionOf,
  };
};
