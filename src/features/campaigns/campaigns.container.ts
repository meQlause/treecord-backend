import { asFunction, type AwilixContainer } from 'awilix';
import type { Cradle } from '../../container.js';
import { openSlotCounts } from '../jobs/index.js';
import { campaignsRepository } from './campaigns.repository.js';
import { createCampaignsService } from './campaigns.service.js';

export type CampaignsCradle = { campaignsService: ReturnType<typeof createCampaignsService> };

/** be-architecture §6: this feature's registrations. Stateless, so one instance serves every request. */
export const registerCampaigns = (container: AwilixContainer<Cradle>): void => {
  container.register({
    campaignsService: asFunction(({ database, chainNow, clock }: Cradle) =>
      createCampaignsService({
        repository: campaignsRepository(database),
        queuedClaims: (campaign, planter) => openSlotCounts(database, 'claim', campaign, planter),
        chainNow,
        now: clock,
      }),
    ).singleton(),
  });
};
