import { asFunction, type AwilixContainer } from 'awilix';
import type { Cradle } from '../../container.js';
import { getDeployment } from '../../generated/frozen/addresses.js';
import { carbonRepository } from './carbon.repository.js';
import { createCarbonService } from './carbon.service.js';

export type CarbonCradle = { carbonService: ReturnType<typeof createCarbonService> };

/** be-architecture §6: this feature's registrations. The ledger's own balance is the inventory (FR-213), and its
 *  address comes from the frozen deployment of CHAIN_ID. */
export const registerCarbon = (container: AwilixContainer<Cradle>): void => {
  container.register({
    carbonService: asFunction(({ database, config, blockTime }: Cradle) =>
      createCarbonService({
        repository: carbonRepository(
          database,
          getDeployment(config.CHAIN_ID).carbonLedger.toLowerCase(),
        ),
        chainId: config.CHAIN_ID,
        blockTime,
      }),
    ).singleton(),
  });
};
