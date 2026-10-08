import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../common/errors';
import { asyncHandler, headerValue, parseOrThrow, pathParam } from '../common/http';
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

const CreateAppointmentSchema = z.object({
  dealership_id: z.string().min(1),
  service_type_code: z.string().min(1),
  vin: z.string().min(1),
  customer: z.object({
    name: z.string().min(1),
    phone: z.string().min(1).optional(),
    email: z.string().email().optional(),
  }),
  bay_id: z.string().min(1),
  technician_id: z.string().min(1),
  start_at: z.string().min(1),
  end_at: z.string().min(1),
  idempotency_key: z.string().min(1).optional(),
});

export function bookingRouter(service: BookingService): Router {
  const router = Router();

  /** Advisory slot search. */
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

  /** Authoritative booking: transactional check-and-reserve. */
  router.post(
    '/appointments',
    asyncHandler(async (req, res) => {
      const body = parseOrThrow(CreateAppointmentSchema, req.body, 'body');
      const idempotencyKey = body.idempotency_key ?? headerValue(req, 'idempotency-key');
      if (!idempotencyKey) {
        throw new AppError(422, 'VALIDATION_FAILED', 'idempotency_key is required');
      }

      const result = await service.createAppointment({
        dealershipId: body.dealership_id,
        serviceTypeCode: body.service_type_code,
        vin: body.vin,
        customer: body.customer,
        bayId: body.bay_id,
        technicianId: body.technician_id,
        startAt: body.start_at,
        endAt: body.end_at,
        idempotencyKey,
      });

      switch (result.outcome) {
        case 'created':
        case 'duplicate':
          res.status(201).json({ appointment: result.appointment });
          return;
        case 'conflict':
          logger.info(
            { dealership_id: body.dealership_id, outcome: 'slot_taken' },
            'booking conflict',
          );
          res.status(409).json({ error: 'slot_taken', next_available: result.nextAvailable });
          return;
        case 'invalid_slot':
          res.status(422).json({ error: 'INVALID_SLOT', message: result.reason });
          return;
      }
    }),
  );

  /** Read a single appointment. */
  router.get(
    '/appointments/:id',
    asyncHandler(async (req, res) => {
      const appointment = await service.getAppointment(pathParam(req, 'id'));
      if (!appointment) {
        throw new AppError(404, 'NOT_FOUND', 'appointment not found');
      }
      res.json({ appointment });
    }),
  );

  /** Confirm a held appointment (HELD -> CONFIRMED). */
  router.post(
    '/appointments/:id/confirm',
    asyncHandler(async (req, res) => {
      res.json({ appointment: await service.confirm(pathParam(req, 'id')) });
    }),
  );

  /** Cancel a held or confirmed appointment. */
  router.post(
    '/appointments/:id/cancel',
    asyncHandler(async (req, res) => {
      res.json({ appointment: await service.cancel(pathParam(req, 'id')) });
    }),
  );

  return router;
}
