import { txUrl } from '../../shared/chain/explorer.js';
import type { BatchRow, CertificateRow, HoldingRows, RetirementRow } from './carbon.repository.js';
import { availability } from './carbon.rules.js';

type SpeciesColumns = { species_code: string | null; species_name: string | null };

const speciesOf = (row: SpeciesColumns) =>
  row.species_code === null ? null : { code: row.species_code, name: row.species_name };

const tx = (chainId: number, hash: string) => ({ hash, url: txUrl(chainId, hash) });

/** §1 item. `issuedAt` is the block time, or null until it could be read. */
export const toBatch = (row: BatchRow, chainId: number, issuedAt: Date | null) => {
  const inventory = row.inventory ?? '0';

  return {
    batchId: row.batch_id,
    label: 'issued',
    campaign: {
      address: row.campaign_address,
      title: row.title,
      region: row.region_name,
      species: speciesOf(row),
    },
    registry: row.registry,
    vintage: row.vintage,
    serialStart: row.serial_start,
    serialEnd: row.serial_end,
    issuedAmount: row.amount,
    inventoryAmount: inventory,
    usdcPerTonne: row.price_usdc_per_tonne,
    availability: availability(inventory, row.price_usdc_per_tonne),
    issuedAt: issuedAt?.toISOString() ?? null,
    issuedTx: tx(chainId, row.issued_tx),
  };
};

/** §3 retirement; an empty purpose reads "No purpose given" (FR-230). */
export const toRetirement = (row: RetirementRow) => ({
  retirementId: row.retirement_id,
  batchId: row.batch_id,
  registry: row.registry,
  amount: row.amount,
  beneficiary: row.beneficiary,
  purpose: row.purpose === '' ? null : row.purpose,
  retiredAt: row.retired_at.toISOString(),
  txHash: row.tx_hash,
  registryRetirement: { status: row.registry_retirement_status, reference: row.registry_reference },
});

/** §3 without the wallet and the retirements page. */
export const toHoldings = ({ summary, reservations, balances }: HoldingRows) => ({
  summary: {
    issuedAmount: summary.issued ?? '0',
    allocatedAmount: summary.allocated ?? '0',
    unfilledAmount: summary.unfilled ?? '0',
    retiredAmount: summary.retired ?? '0',
  },
  reservations: reservations.map((row) => ({
    campaign: {
      address: row.address,
      title: row.title,
      region: row.region_name,
      species: speciesOf(row),
    },
    label: 'pre-certification',
    reservedAmount: row.reserved_amount,
    allocatedAmount: row.allocated_amount,
    unfilledAmount: row.unfilled_amount,
    declined: row.declined,
    updatedAt: row.updated_at.toISOString(),
  })),
  balances: balances.map((row) => ({
    batchId: row.batch_id,
    label: 'issued',
    campaign: { address: row.address, title: row.title, region: row.region_name },
    registry: row.registry,
    vintage: row.vintage,
    serialStart: row.serial_start,
    serialEnd: row.serial_end,
    amount: row.amount,
    retiredAmount: row.retired_amount ?? '0',
  })),
});

/** §5: the public certificate. `holder` is the chain address, never a profile field. */
export const toCertificate = (row: CertificateRow, chainId: number) => {
  const { batchId, registry, amount, beneficiary, purpose, retiredAt, txHash, registryRetirement } =
    toRetirement(row);

  return {
    retirementId: row.retirement_id,
    label: 'issued',
    amount,
    beneficiary,
    purpose,
    retiredAt,
    holder: row.holder_address,
    txHash,
    registryRetirement,
    batch: {
      batchId,
      registry,
      vintage: row.vintage,
      serialStart: row.serial_start,
      serialEnd: row.serial_end,
      issuedAmount: row.issued_amount,
      issuedTx: tx(chainId, row.issued_tx),
    },
    campaign: {
      address: row.campaign_address,
      title: row.title,
      region: { name: row.region_name, geohash: row.region_geohash },
      species: speciesOf(row),
      treeTarget: row.tree_target,
    },
  };
};
