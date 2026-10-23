import { asFunction, type AwilixContainer } from 'awilix';
import type { Cradle } from '../../container.js';
import { createOperationsService } from './operations.service.js';

export type OperationsCradle = { operationsService: ReturnType<typeof createOperationsService> };

/** be-architecture §6: this feature's registrations. Stateless, so one instance serves every request. */
export const registerOperations = (container: AwilixContainer<Cradle>): void => {
  container.register({
    operationsService: asFunction(({ database, chainNow, clock }: Cradle) =>
      createOperationsService({ database, chainNow, clock }),
    ).singleton(),
  });
};
