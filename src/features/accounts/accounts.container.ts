import { asFunction, type AwilixContainer } from 'awilix';
import type { Cradle } from '../../container.js';
import { accountsRepository } from './accounts.repository.js';
import { createAccountsService } from './accounts.service.js';

export type AccountsCradle = { accountsService: ReturnType<typeof createAccountsService> };

/** be-architecture §6: this feature's registrations. Stateless, so one instance serves every request. */
export const registerAccounts = (container: AwilixContainer<Cradle>): void => {
  container.register({
    accountsService: asFunction(({ database, walletOf, config }: Cradle) =>
      createAccountsService({
        repository: accountsRepository(database),
        walletOf,
        faucet:
          config.FAUCET_ETH_WEI !== undefined && config.FAUCET_USDC_UNITS !== undefined
            ? { database, ethWei: config.FAUCET_ETH_WEI, usdcUnits: config.FAUCET_USDC_UNITS }
            : null,
      }),
    ).singleton(),
  });
};
