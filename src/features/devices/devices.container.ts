import { asFunction, type AwilixContainer } from 'awilix';
import type { Cradle } from '../../container.js';
import { createDevicesService } from './devices.service.js';

export type DevicesCradle = { devicesService: ReturnType<typeof createDevicesService> };

/** be-architecture §6: this feature's registrations. Stateless, so one instance serves every request. */
export const registerDevices = (container: AwilixContainer<Cradle>): void => {
  container.register({
    devicesService: asFunction(({ database }: Cradle) =>
      createDevicesService({ database }),
    ).singleton(),
  });
};
