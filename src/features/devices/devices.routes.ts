import { Router } from 'express';
import { z } from 'zod';
import { pathParam } from '../../shared/http/params.js';
import { allowRoles } from '../../shared/http/roles.js';
import { validate } from '../../shared/http/validate.js';
import type { DeviceRow } from './devices.repository.js';
import { registerDeviceSchema, type RegisterDeviceInput } from './devices.schema.js';
import type { createDevicesService } from './devices.service.js';

type DevicesService = ReturnType<typeof createDevicesService>;
type Caller = { id: string };

const CREATED = 201;

/** devices.md device object; the public JWK is never returned. */
const toDevice = (row: DeviceRow) => ({
  id: row.id,
  thumbprint: row.thumbprint,
  label: row.label,
  createdAt: row.created_at.toISOString(),
  revokedAt: row.revoked_at?.toISOString() ?? null,
});

const callerId = (locals: Record<string, unknown>): string => (locals['profile'] as Caller).id;

/** Private routes, mounted under /api/v1 behind authentication (devices §1–§3): planters only. */
export const devicesRouter = (devices: DevicesService): Router =>
  Router()
    .use('/devices', allowRoles('planter'))
    .get('/devices', async (_req, res) => {
      const items = await devices.active(callerId(res.locals));

      // bounded at three by the trigger, so never paginated (devices §1)
      res.json({ items: items.map(toDevice), nextCursor: null, total: items.length });
    })
    .post('/devices', validate(registerDeviceSchema), async (_req, res) => {
      const device = await devices.register(
        callerId(res.locals),
        res.locals['body'] as RegisterDeviceInput,
      );

      res.status(CREATED).json({ device: toDevice(device) });
    })
    .delete('/devices/:id', async (req, res) => {
      const { device, idempotent } = await devices.revoke(
        callerId(res.locals),
        pathParam(z.uuid(), req.params.id),
      );

      res.json({ device: toDevice(device), ...(idempotent ? { idempotent } : {}) });
    });
