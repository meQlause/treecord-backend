import { maybeOne, query, type Queryable } from '../worker-db.repository.js';

/** Campaign clones already mirrored on this chain. */
export const loadCampaignAddresses = async (
  database: Queryable,
  chainId: number,
): Promise<string[]> =>
  (
    await query<{ address: string }>(
      database,
      'load campaign addresses',
      'select address from public.campaigns where chain_id = $1',
      [chainId],
    )
  ).map((row) => row.address);

export const readCursor = async (database: Queryable, name: string): Promise<bigint | null> => {
  const row = await maybeOne<{ last_block: number }>(
    database,
    'read chain cursor',
    'select last_block from public.chain_cursor where name = $1',
    [name],
  );

  return row ? BigInt(row.last_block) : null;
};

export const writeCursor = async (
  database: Queryable,
  name: string,
  block: bigint,
): Promise<void> => {
  await query(
    database,
    'write chain cursor',
    `insert into public.chain_cursor (name, last_block) values ($1, $2)
     on conflict (name) do update set last_block = excluded.last_block`,
    [name, Number(block)],
  );
};
