import type { ProfileRow } from './accounts.repository.js';

/** docs/BE/features/accounts.md §1 response: one source per value, instants as ISO 8601 UTC. */
export const toProfileDto = (row: ProfileRow) => ({
  id: row.id,
  walletAddress: row.wallet_address,
  role: row.role,
  displayName: row.display_name,
  isBuyer: row.is_buyer,
  carbonRightsAgreementAccepted: row.carbon_rights_agreement_hash !== null,
  carbonRightsAcceptedAt: row.carbon_rights_accepted_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
});
