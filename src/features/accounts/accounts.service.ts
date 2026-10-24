import { walletFromUserId } from '../../generated/frozen/wallet-auth.js';
import { keccak256, stringToHex } from 'viem';
import { CARBON_RIGHTS_AGREEMENT_VERSION } from '../../generated/frozen/constants.js';
import { DomainError } from '../../shared/errors.js';
import type { DatabaseClient } from '../../shared/db/database.js';
import { enqueue } from '../jobs/index.js';
import {
  accountsRepository,
  type AccountsRepository,
  type ProfileRow,
} from './accounts.repository.js';
import type { UpdateProfileInput } from './accounts.schema.js';

// accounts §2: the hash stored on acceptance names the agreement version the planter accepted.
const AGREEMENT_HASH = keccak256(stringToHex(CARBON_RIGHTS_AGREEMENT_VERSION));

/** The embedded wallet Privy reports for a user, or null when it has none yet or the lookup failed. */
type WalletLookup = (privyUserId: string) => Promise<string | null>;

/** The testnet faucet's amounts (wei, USDC base units), and the database its jobs commit in, with the wallet. */
type Faucet = { database: DatabaseClient; ethWei: string; usdcUnits: string };

type AccountsDependencies = {
  repository: AccountsRepository;
  walletOf: WalletLookup;
  faucet?: Faucet | null;
};

/** A write that stores a wallet; resolves with the profile id when it did. */
type WalletWrite = (repository: AccountsRepository) => Promise<string | undefined>;

/** docs/BE/features/accounts.md §0: the profile behind a verified token, created on first sign-in. */
export const createAccountsService = ({
  repository,
  walletOf,
  faucet = null,
}: AccountsDependencies) => {
  // the faucet's two jobs commit with the wallet they follow, keyed per profile, so an account is sent them once
  const storeWallet = async (write: WalletWrite, wallet: string | null): Promise<void> => {
    if (faucet === null || wallet === null) {
      await write(repository);

      return;
    }

    await faucet.database.transaction().execute(async (trx) => {
      const profileId = await write(accountsRepository(trx));

      if (profileId === undefined) {
        return;
      }

      for (const [kind, amount] of [
        ['faucet_eth', faucet.ethWei],
        ['faucet_usdc', faucet.usdcUnits],
      ] as const) {
        await enqueue(trx, {
          kind,
          payload: { to: wallet, amount },
          createdBy: profileId,
          idempotencyKey: `${kind}:${profileId}`,
        });
      }
    });
  };

  // accounts §0 DEMO_WALLET_AUTH: a demo sign-in's wallet is the token's signer, named in its user id, not Privy's
  const lowercaseWallet = async (privyUserId: string): Promise<string | null> =>
    walletFromUserId(privyUserId) ?? (await walletOf(privyUserId))?.toLowerCase() ?? null;

  const mustLoad = async (privyUserId: string): Promise<ProfileRow> => {
    const profile = await repository.byPrivyUserId(privyUserId);

    if (profile === undefined) {
      throw new Error('profile missing right after it was written');
    }

    return profile;
  };

  return {
    resolveProfile: async (privyUserId: string): Promise<ProfileRow> => {
      const existing = await repository.byPrivyUserId(privyUserId);

      if (existing === undefined) {
        // step 4: a unique-wallet violation becomes 409 wallet_already_linked (error-handling §2.1)
        const wallet = await lowercaseWallet(privyUserId);

        await storeWallet((store) => store.insertIgnoringExisting(privyUserId, wallet), wallet);

        return mustLoad(privyUserId);
      }

      if (existing.wallet_address !== null) {
        return existing;
      }

      // step 5: Privy may have provisioned the wallet since; the next request retries when it has not
      const wallet = await lowercaseWallet(privyUserId);

      if (wallet === null) {
        return existing;
      }

      await storeWallet((store) => store.setWalletIfMissing(existing.id, wallet), wallet);

      return mustLoad(privyUserId);
    },

    /** accounts §2: no row back means the role guard refused it, i.e. an auditor or operator sent `role`. */
    updateProfile: async (id: string, input: UpdateProfileInput): Promise<ProfileRow> => {
      const updated = await repository.updateProfile(id, input, AGREEMENT_HASH);

      if (updated === undefined) {
        throw new DomainError('role_locked');
      }

      return updated;
    },
  };
};
