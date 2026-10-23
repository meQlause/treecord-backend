import { calculateJwkThumbprint } from 'jose';
import type { DatabaseClient } from '../../shared/db/database.js';
import { DomainError } from '../../shared/errors.js';
import { devicesRepository, type DeviceRow } from './devices.repository.js';
import type { RegisterDeviceInput } from './devices.schema.js';

/** docs/BE/features/devices.md: a planter's signing keys (public halves only, NFR-001). */
export const createDevicesService = ({ database }: { database: DatabaseClient }) => {
  const repository = devicesRepository(database);

  return {
    active: (profileId: string): Promise<DeviceRow[]> => repository.active(profileId),

    /** §2: one transaction, the profile row locked first; the trigger and the unique key decide. */
    register: async (profileId: string, { publicKeyJwk, label }: RegisterDeviceInput) => {
      // RFC 7638 over the four members only, so it always matches what FR-131 recomputes
      const thumbprint = await calculateJwkThumbprint(publicKeyJwk, 'sha256');

      return database.transaction().execute(async (trx) => {
        const writes = devicesRepository(trx);

        await writes.lockProfile(profileId);

        return writes.insert({ profileId, publicKeyJwk, thumbprint, label });
      });
    },

    /** §3: revoked once; a repeat reads back the original time. Another planter's device does not exist. */
    revoke: async (profileId: string, id: string) => {
      const revoked = await repository.revoke(profileId, id);

      if (revoked !== undefined) {
        return { device: revoked, idempotent: false };
      }

      const earlier = await repository.owned(profileId, id);

      if (earlier === undefined) {
        throw new DomainError('not_found');
      }

      return { device: earlier, idempotent: true };
    },
  };
};
