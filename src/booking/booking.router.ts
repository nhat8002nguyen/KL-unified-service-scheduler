import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseOrThrow } from '../common/http';
import { logger } from '../telemetry/logger';
import { slotSearchDuration } from '../telemetry/metrics';
import type { BookingService } from './booking.types';

const SlotQuerySchema = z.object({
  dealership_id: z.string().min(1),
  service_type_code: z.string().min(1),
  vin: z.string().min(1),
  desired_at: z.string().min(1),
  horizon_days: z.coerce.number().int().min(0).max(60).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

/** Advisory slot search: `GET /slots`. */
export function bookingRouter(service: BookingService): Router {
  const router = Router();

  router.get(
    '/slots',
    asyncHandler(async (req, res) => {
      const q = parseOrThrow(SlotQuerySchema, req.query, 'query');
      const end = slotSearchDuration.startTimer();
      const slots = await service.searchSlots({
        dealershipId: q.dealership_id,
        serviceTypeCode: q.service_type_code,
        vin: q.vin,
        desiredAt: q.desired_at,
        horizonDays: q.horizon_days,
        limit: q.limit,
      });
      end();

      logger.info(
        {
          dealership_id: q.dealership_id,
          service_type_code: q.service_type_code,
          desired_at: q.desired_at,
          slot_count: slots.length,
        },
        'slot search',
      );
      res.json({ slots });
    }),
  );

  return router;
}
