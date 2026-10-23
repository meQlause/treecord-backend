import { asFunction, type AwilixContainer } from 'awilix';
import type { Cradle } from '../../container.js';
import { treesRepository } from './trees.repository.js';
import { createTreesService } from './trees.service.js';

export type TreesCradle = { treesService: ReturnType<typeof createTreesService> };

/** be-architecture §6: this feature's registrations. Stateless, so one instance serves every request. */
export const registerTrees = (container: AwilixContainer<Cradle>): void => {
  container.register({
    treesService: asFunction(({ database, storage, chainNow }: Cradle) =>
      createTreesService({ repository: treesRepository(database), storage, chainNow }),
    ).singleton(),
  });
};
