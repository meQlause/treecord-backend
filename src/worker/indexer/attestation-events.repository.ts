import { query } from '../worker-db.repository.js';
import type { ApplyContext } from './apply.service.js';
import type { EventMeta } from './decode.rules.js';

/** The submission with this nonce is on-chain. Its attestation job is confirmed too, if the relayer missed it. */
export const onAttestationAccepted = async (
  context: ApplyContext,
  meta: EventMeta,
  nonce: bigint,
): Promise<void> => {
  const value = nonce.toString();
  const updated = await query(
    context.db,
    'mark submission on-chain',
    `update public.submissions set status = 'onchain', tx_hash = $2, error = null
     where attestation_nonce = $1 and status in ('attested', 'failed', 'onchain')
     returning id`,
    [value, meta.txHash],
  );

  await query(
    context.db,
    'confirm attestation job',
    `update public.relayer_jobs set status = 'confirmed', tx_hash = $2, last_error = null
     where kind = 'attestation' and payload ->> 'nonce' = $1 and status <> 'confirmed'`,
    [value, meta.txHash],
  );

  if (updated.length === 0) {
    context.log.warn(
      { nonce: value, tx: meta.txHash },
      'attestation accepted for an unknown nonce',
    );
  }
};
