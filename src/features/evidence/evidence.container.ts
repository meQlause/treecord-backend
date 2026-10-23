import { asFunction, type AwilixContainer } from 'awilix';
import type { Cradle } from '../../container.js';
import { createEvidenceService } from './evidence.service.js';

export type EvidenceCradle = { evidenceService: ReturnType<typeof createEvidenceService> };

/** be-architecture §6: this feature's registrations. Stateless, so one instance serves every request. */
export const registerEvidence = (container: AwilixContainer<Cradle>): void => {
  container.register({
    evidenceService: asFunction(({ database, chainNow, clock, randomBytes }: Cradle) =>
      createEvidenceService({ database, chainNow, now: clock, randomBytes }),
    ).singleton(),
  });
};
