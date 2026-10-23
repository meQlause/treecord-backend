import { asFunction, type AwilixContainer } from 'awilix';
import type { Cradle } from '../../container.js';
import { createPlanterService } from './planter.service.js';

export type PlanterCradle = { planterService: ReturnType<typeof createPlanterService> };

/** be-architecture §6: this feature's registrations. Stateless, so one instance serves every request. */
export const registerPlanter = (container: AwilixContainer<Cradle>): void => {
  container.register({
    planterService: asFunction(({ database, chainNow, clock, randomBytes }: Cradle) =>
      createPlanterService({ database, chainNow, now: clock, randomBytes }),
    ).singleton(),
  });
};
