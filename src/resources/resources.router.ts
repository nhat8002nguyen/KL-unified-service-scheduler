import { Router } from 'express';
import { AppError } from '../common/errors';
import { asyncHandler, pathParam } from '../common/http';
import type {
  BayReader,
  DealershipReader,
  TechnicianReader,
  VehicleReader,
} from './resources.types';

export interface ResourcesDeps {
  vehicles: VehicleReader;
  dealerships: DealershipReader;
  bays: BayReader;
  technicians: TechnicianReader;
}

/** Read endpoints over reference data. */
export function resourcesRouter(deps: ResourcesDeps): Router {
  const router = Router();

  router.get(
    '/dealerships/:id',
    asyncHandler(async (req, res) => {
      const id = pathParam(req, 'id');
      const dealership = await deps.dealerships.getById(id);
      if (!dealership) {
        throw new AppError(404, 'NOT_FOUND', `Unknown dealership ${id}`);
      }
      res.json(dealership);
    }),
  );

  router.get(
    '/vehicles/:vin',
    asyncHandler(async (req, res) => {
      const vin = pathParam(req, 'vin');
      const vehicle = await deps.vehicles.getByVin(vin);
      if (!vehicle) {
        throw new AppError(404, 'NOT_FOUND', `Unknown VIN ${vin}`);
      }
      res.json(vehicle);
    }),
  );

  return router;
}
