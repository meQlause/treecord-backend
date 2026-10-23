import { keccak256, stringToHex } from 'viem';
import { CARBON_RIGHTS_AGREEMENT_VERSION } from '../../generated/frozen/constants.js';
import { DomainError } from '../../shared/errors.js';
import type { AccountsRepository, ProfileRow } from './accounts.repository.js';
import type { UpdateProfileInput } from './accounts.schema.js';

// accounts §2: the hash stored on acceptance names the agreement version the planter accepted.
const AGREEMENT_HASH = keccak256(stringToHex(CARBON_RIGHTS_AGREEMENT_VERSION));

/** The embedded wallet Privy reports for a user, or null when it has none yet or the lookup failed. */
type WalletLookup = (privyUserId: string) => Promise<string | null>;

type AccountsDependencies = { repository: AccountsRepository; walletOf: WalletLookup };

/** docs/BE/features/accounts.md §0: the profile behind a verified token, created on first sign-in. */
export const createAccountsService = ({ repository, walletOf }: AccountsDependencies) => {
  const lowercaseWallet = async (privyUserId: string): Promise<string | null> =>
    (await walletOf(privyUserId))?.toLowerCase() ?? null;

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
        await repository.insertIgnoringExisting(privyUserId, await lowercaseWallet(privyUserId));

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

      await repository.setWalletIfMissing(existing.id, wallet);

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
