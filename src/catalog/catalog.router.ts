import { Router } from 'express';
import { asyncHandler } from '../common/http';
import type { CatalogRepository } from './catalog.types';

/** catalogRouter builds the router serving service-type reference data. */
export function catalogRouter(repo: CatalogRepository): Router {
  const router = Router();

  router.get(
    '/service-types',
    asyncHandler(async (_req, res) => {
      const serviceTypes = await repo.listServiceTypes();
      res.json({ service_types: serviceTypes });
    }),
  );

  return router;
}
