import { asFunction, type AwilixContainer } from 'awilix';
import type { Cradle } from '../../container.js';
import { createFlagsService } from './flags.service.js';

export type FlagsCradle = { flagsService: ReturnType<typeof createFlagsService> };

/** be-architecture §6: this feature's registrations. Stateless, so one instance serves every request. */
export const registerFlags = (container: AwilixContainer<Cradle>): void => {
  container.register({
    flagsService: asFunction(({ database }: Cradle) =>
      createFlagsService({ database }),
    ).singleton(),
  });
};
