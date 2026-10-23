import { sql, type Kysely, type Selectable } from 'kysely';
import type { DB, Devices } from '../../generated/db.js';

export type DeviceRow = Selectable<Devices>;

type NewDevice = {
  profileId: string;
  publicKeyJwk: { kty: string; crv: string; x: string; y: string };
  thumbprint: string;
  label: string;
};

export const devicesRepository = (database: Kysely<DB>) => ({
  /** §1: active devices, newest first; at most three by the enforce_device_limit trigger. */
  active: (profileId: string): Promise<DeviceRow[]> =>
    database
      .selectFrom('devices')
      .selectAll()
      .where('profile_id', '=', profileId)
      .where('revoked_at', 'is', null)
      .orderBy('created_at', 'desc')
      .execute(),

  /** §2 step 1: serialises one planter's registrations so the trigger's count cannot race. */
  lockProfile: async (profileId: string): Promise<void> => {
    await database
      .selectFrom('profiles')
      .select('id')
      .where('id', '=', profileId)
      .forUpdate()
      .execute();
  },

  /** §2 step 2: the trigger counts and the thumbprint key is unique; the error handler maps both. */
  insert: ({ profileId, publicKeyJwk, thumbprint, label }: NewDevice): Promise<DeviceRow> =>
    database
      .insertInto('devices')
      .values({ profile_id: profileId, public_key_jwk: publicKeyJwk, thumbprint, label })
      .returningAll()
      .executeTakeFirstOrThrow(),

  /** §3: the single decision; of two concurrent revokes exactly one sets the time. */
  revoke: (profileId: string, id: string): Promise<DeviceRow | undefined> =>
    database
      .updateTable('devices')
      .set({ revoked_at: sql<Date>`now()` })
      .where('id', '=', id)
      .where('profile_id', '=', profileId)
      .where('revoked_at', 'is', null)
      .returningAll()
      .executeTakeFirst(),

  owned: (profileId: string, id: string): Promise<DeviceRow | undefined> =>
    database
      .selectFrom('devices')
      .selectAll()
      .where('id', '=', id)
      .where('profile_id', '=', profileId)
      .executeTakeFirst(),
});
