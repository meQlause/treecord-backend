import { asFunction, type AwilixContainer } from 'awilix';
import type { Cradle } from '../../container.js';
import { createReportsService } from './reports.service.js';

export type ReportsCradle = { reportsService: ReturnType<typeof createReportsService> };

/** be-architecture §6: this feature's registrations. Stateless, so one instance serves every request. */
export const registerReports = (container: AwilixContainer<Cradle>): void => {
  container.register({
    reportsService: asFunction(({ database, clock }: Cradle) =>
      createReportsService({ database, now: clock }),
    ).singleton(),
  });
};
