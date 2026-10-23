import { asFunction, type AwilixContainer } from 'awilix';
import type { Cradle } from '../../container.js';
import { createDonorService } from './donor.service.js';

export type DonorCradle = { donorService: ReturnType<typeof createDonorService> };

/** be-architecture §6: this feature's registrations. Stateless, so one instance serves every request. */
export const registerDonor = (container: AwilixContainer<Cradle>): void => {
  container.register({
    donorService: asFunction(({ database }: Cradle) =>
      createDonorService({ database }),
    ).singleton(),
  });
};
