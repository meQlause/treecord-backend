import type { DatabaseClient } from '../../shared/db/database.js';
import { DomainError } from '../../shared/errors.js';
import { toEvidenceItem, toReport } from './reports.mapper.js';
import { reportsRepository, type ReportsRepository } from './reports.repository.js';
import { decodeEvidenceCursor, encodeEvidenceCursor } from './reports.rules.js';

type ReportsDependencies = {
  database: DatabaseClient;
  /** The server clock: `generatedAt` is when the read starts (reports §1). */
  now: () => Date;
};

export type EvidenceQuery = { cursor?: string; limit: number };

const FIRST_PAGE: EvidenceQuery = { limit: 20 };

/** FR-069: one page of the evidence record, read on the report's transaction. */
const evidencePage = async (
  repository: ReportsRepository,
  address: string,
  { cursor, limit }: EvidenceQuery,
) => {
  const after = cursor === undefined ? null : decodeEvidenceCursor(cursor);
  const [rows, total] = await Promise.all([
    repository.evidencePage(address, after, limit + 1),
    repository.evidenceTotal(address),
  ]);
  const items = rows.slice(0, limit);
  const last = items.at(-1);

  return {
    items: items.map(toEvidenceItem),
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeEvidenceCursor({ block: last.block_number, logIndex: last.log_index })
        : null,
    total,
  };
};

/** docs/BE/features/reports.md: the public impact report. No chain read, so it never fails on the RPC. */
export const createReportsService = ({ database, now }: ReportsDependencies) => {
  // reports §1 consistency: every figure from one read-only snapshot while the indexer writes
  const inSnapshot = <Result>(read: (repository: ReportsRepository) => Promise<Result>) =>
    database
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute((trx) => read(reportsRepository(trx)));

  const mustExist = async (repository: ReportsRepository, address: string) => {
    const campaign = await repository.campaign(address);

    if (campaign === undefined) {
      throw new DomainError('not_found');
    }

    return campaign;
  };

  return {
    report: (address: string) =>
      inSnapshot(async (repository) => {
        const generatedAt = now();
        const campaign = await mustExist(repository, address);
        const [trees, funding, payoutsByMilestone, forfeited, batches, retired, evidence] =
          await Promise.all([
            repository.trees(address, generatedAt),
            repository.funding(address),
            repository.payoutsByMilestone(address),
            repository.forfeited(address),
            repository.batches(address),
            repository.retired(address),
            evidencePage(repository, address, FIRST_PAGE),
          ]);
        const records = { trees, funding, payoutsByMilestone, forfeited, batches, retired };

        return { report: { ...toReport(generatedAt, campaign, records), evidence } };
      }),

    evidence: (address: string, query: EvidenceQuery) =>
      inSnapshot(async (repository) => {
        await mustExist(repository, address);

        return evidencePage(repository, address, query);
      }),
  };
};
