import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseOrThrow, pathParam } from '../common/http';
import type { DiaryService } from './diary.types';

const WindowSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

/** Service-manager and technician views over the diary. */
export function diaryRouter(service: DiaryService): Router {
  const router = Router();

  router.get(
    '/technicians/:id/appointments',
    asyncHandler(async (req, res) => {
      const q = parseOrThrow(WindowSchema, req.query, 'query');
      const appointments = await service.technicianCalendar(pathParam(req, 'id'), q.from, q.to);
      res.json({ appointments });
    }),
  );

  router.get(
    '/dealerships/:id/capacity',
    asyncHandler(async (req, res) => {
      const q = parseOrThrow(WindowSchema, req.query, 'query');
      res.json(await service.dealershipCapacity(pathParam(req, 'id'), q.from, q.to));
    }),
  );

  return router;
}
