import { asFunction, type AwilixContainer } from 'awilix';
import type { Cradle } from '../../container.js';
import { jobsRepository } from './jobs.repository.js';
import { createJobsService } from './jobs.service.js';

export type JobsCradle = { jobsService: ReturnType<typeof createJobsService> };

/** be-architecture §6: this feature's registrations. Stateless, so one instance serves every request. */
export const registerJobs = (container: AwilixContainer<Cradle>): void => {
  container.register({
    jobsService: asFunction(({ database }: Cradle) =>
      createJobsService({ repository: jobsRepository(database) }),
    ).singleton(),
  });
};
