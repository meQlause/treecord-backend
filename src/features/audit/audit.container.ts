import { randomUUID } from 'node:crypto';
import { asFunction, type AwilixContainer } from 'awilix';
import type { Cradle } from '../../container.js';
import { createAuditService } from './audit.service.js';

export type AuditCradle = { auditService: ReturnType<typeof createAuditService> };

/** be-architecture §6: this feature's registrations. Stateless, so one instance serves every request. */
export const registerAudit = (container: AwilixContainer<Cradle>): void => {
  container.register({
    auditService: asFunction(({ database, latestBlock, clock, randomBytes, storage }: Cradle) =>
      createAuditService({ database, latestBlock, clock, randomBytes, storage, newId: randomUUID }),
    ).singleton(),
  });
};
