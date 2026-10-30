-- FR-243, FR-244 (data-spec §5.2.6): the indexer's mirror of TreecordKeeper.Enforced, one row per log. A forfeit is
-- "enforced by Chainlink" when a row here shares (tree_id, tx_hash) with its milestone_forfeits row.
create table public.chainlink_enforcements (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('forfeit', 'expire')),
  campaign_address public.eth_address not null references public.campaigns (address) on delete cascade,
  tree_id bigint not null references public.trees (tree_id) on delete cascade,
  milestone smallint check (
    -- a NULL check passes, so the forfeit side must say "is not null" or a forfeit could lose its milestone
    (kind = 'forfeit' and milestone is not null and milestone between 0 and 5)
    or (kind = 'expire' and milestone is null)
  ),
  block_number bigint not null,
  block_time timestamptz not null,
  tx_hash public.hex32 not null,
  log_index integer not null,
  unique (tx_hash, log_index)
);
create index chainlink_enforcements_tree_tx_idx on public.chainlink_enforcements (tree_id, tx_hash);
alter table public.chainlink_enforcements enable row level security;
revoke all on public.chainlink_enforcements from anon, authenticated;
