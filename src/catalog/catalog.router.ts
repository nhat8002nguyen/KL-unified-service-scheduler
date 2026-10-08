import { Router } from 'express';
import { asyncHandler } from '../common/http';
import type { CatalogRepository } from './catalog.types';

/** `GET /service-types` — reference data for the booking UI. */
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
