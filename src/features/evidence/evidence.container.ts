import { asFunction, type AwilixContainer } from 'awilix';
import type { Cradle } from '../../container.js';
import { createEvidenceService } from './evidence.service.js';

export type EvidenceCradle = { evidenceService: ReturnType<typeof createEvidenceService> };

/** be-architecture §6: this feature's registrations. Stateless, so one instance serves every request. */
export const registerEvidence = (container: AwilixContainer<Cradle>): void => {
  container.register({
    evidenceService: asFunction(
      ({ database, storage, chainNow, clock, randomBytes, attester }: Cradle) =>
        createEvidenceService({ database, storage, chainNow, now: clock, randomBytes, attester }),
    ).singleton(),
  });
};
