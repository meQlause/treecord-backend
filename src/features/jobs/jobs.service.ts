import { DomainError } from '../../shared/errors.js';
import type { JobRow, JobsRepository } from './jobs.repository.js';

/** The signed-in caller, as far as job access needs it. */
type Caller = { id: string; role: string };

/** docs/BE/features/jobs.md §2: the creator or an operator reads a job; for anyone else it does not exist. */
export const createJobsService = ({ repository }: { repository: JobsRepository }) => ({
  jobFor: async (caller: Caller, id: string): Promise<JobRow> => {
    const job = await repository.byId(id);

    // by profile id, not role: a donor who created a claim as a planter still reads it (REG-004)
    if (
      job === undefined ||
      (caller.role !== 'operator' && job.created_by_profile_id !== caller.id)
    ) {
      throw new DomainError('not_found');
    }

    return job;
  },
});
