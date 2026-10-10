import { findSlots } from '../availability/availability.engine';
import type { Slot } from '../availability/availability.types';
import type { CatalogReader } from '../catalog/catalog.types';
import { AppError } from '../common/errors';
import { minutesBetween } from '../common/time';
import { hhMmToMinutes, localMinuteOfDay, localWeekday, sameLocalDay } from '../common/tz';
import type {
  Dealership,
  DealershipReader,
  BayReader,
  Technician,
  TechnicianReader,
  VehicleReader,
} from '../resources/resources.types';
import { appointmentConflicts, appointmentOutcomes } from '../telemetry/metrics';
import { fingerprintReserveRequest } from './idempotency';
import type {
  Appointment,
  AppointmentRepository,
  BookingService,
  CreateAppointmentInput,
  CreateAppointmentResult,
  CustomerWriter,
  SearchSlotsQuery,
} from './booking.types';
import type { AppointmentStatus } from '../domain/types';

export interface BookingDeps {
  catalog: CatalogReader;
  vehicles: VehicleReader;
  dealerships: DealershipReader;
  bays: BayReader;
  technicians: TechnicianReader;
  customers: CustomerWriter;
  appointments: AppointmentRepository;
  /** Injectable clock for deterministic tests. */
  clock?: () => Date;
  /** Hold TTL in minutes (from config). */
  holdMinutes?: number;
}

const DEFAULT_HORIZON_DAYS = 7;
const DEFAULT_LIMIT = 10;
const DEFAULT_HOLD_MINUTES = 10;

export class BookingServiceImpl implements BookingService {
  /** constructor stores the injected booking dependencies. */
  constructor(private readonly deps: BookingDeps) {}

  /** searchSlots finds bookable slots for the requested service, vehicle, and dealership within the search horizon. */
  async searchSlots(query: SearchSlotsQuery): Promise<Slot[]> {
    const now = this.now();
    const desired = new Date(query.desiredAt);
    if (Number.isNaN(desired.getTime())) {
      throw new AppError(422, 'VALIDATION_FAILED', 'desired_at is not a valid instant');
    }
    if (desired.getTime() < now.getTime()) {
      throw new AppError(422, 'VALIDATION_FAILED', 'desired_at is in the past');
    }

    const horizonDays = query.horizonDays ?? DEFAULT_HORIZON_DAYS;
    const limit = query.limit ?? DEFAULT_LIMIT;

    const [serviceType, vehicle, dealership] = await Promise.all([
      this.deps.catalog.getServiceTypeDetail(query.serviceTypeCode),
      this.deps.vehicles.getByVin(query.vin),
      this.deps.dealerships.getById(query.dealershipId),
    ]);
    if (!serviceType) throw new AppError(404, 'NOT_FOUND', `Unknown service type ${query.serviceTypeCode}`);
    if (!vehicle) throw new AppError(404, 'NOT_FOUND', `Unknown VIN ${query.vin}`);
    if (!dealership) throw new AppError(404, 'NOT_FOUND', `Unknown dealership ${query.dealershipId}`);

    const from = now.toISOString();
    const to = new Date(now.getTime() + horizonDays * 86_400_000).toISOString();

    const [bays, technicians, busy] = await Promise.all([
      this.deps.bays.listByDealership(query.dealershipId),
      this.deps.technicians.listQualified(query.dealershipId, serviceType.requiredSkills),
      this.deps.appointments.busyIntervals(query.dealershipId, from, to),
    ]);

    return findSlots(
      {
        dealershipId: query.dealershipId,
        serviceType,
        desiredAt: query.desiredAt,
        horizonDays,
        limit,
        now: from,
      },
      { dealership, bays, technicians, busy },
    );
  }

  /**
   * createAppointment validates the request against the catalog, bays, technicians, and opening hours before atomically reserving a hold.
   * Returns the created or duplicate appointment, a conflict with the next available slots, or an invalid-slot reason.
   */
  async createAppointment(input: CreateAppointmentInput): Promise<CreateAppointmentResult> {
    const now = this.now();

    const [serviceType, vehicle, dealership] = await Promise.all([
      this.deps.catalog.getServiceTypeDetail(input.serviceTypeCode),
      this.deps.vehicles.getByVin(input.vin),
      this.deps.dealerships.getById(input.dealershipId),
    ]);
    if (!serviceType) throw new AppError(404, 'NOT_FOUND', `Unknown service type ${input.serviceTypeCode}`);
    if (!vehicle) throw new AppError(404, 'NOT_FOUND', `Unknown VIN ${input.vin}`);
    if (!dealership) throw new AppError(404, 'NOT_FOUND', `Unknown dealership ${input.dealershipId}`);

    const start = new Date(input.startAt);
    const end = new Date(input.endAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return invalid('start_at/end_at is not a valid instant');
    }
    if (minutesBetween(start, end) !== serviceType.durationMin) {
      return invalid(`slot length must equal the service duration (${serviceType.durationMin} min)`);
    }
    if (start.getTime() <= now.getTime()) {
      return invalid('start_at is in the past');
    }

    const bays = await this.deps.bays.listByDealership(input.dealershipId);
    const bay = bays.find((b) => b.id === input.bayId && b.active);
    if (!bay) return invalid('bay is not an active bay at this dealership');
    const requiredBayTypes = serviceType.bayTypes
      .filter((b) => b.kind === 'required')
      .map((b) => b.bayTypeCode);
    if (requiredBayTypes.length > 0 && !requiredBayTypes.includes(bay.bayTypeCode)) {
      return invalid(`service requires bay type ${requiredBayTypes.join('|')}`);
    }

    const technicians = await this.deps.technicians.listQualified(
      input.dealershipId,
      serviceType.requiredSkills,
    );
    const technician = technicians.find((t) => t.id === input.technicianId);
    if (!technician) return invalid('technician is not qualified or not at this dealership');

    if (!withinOpenHours(dealership, start, end)) return invalid('slot is outside dealership hours');
    if (!withinShift(technician, dealership.timezone, start, end)) {
      return invalid('slot is outside the technician shift');
    }

    const customer = await this.deps.customers.upsert(input.customer);

    const startAt = start.toISOString();
    const endAt = end.toISOString();
    const requestFingerprint = fingerprintReserveRequest({
      dealershipId: input.dealershipId,
      serviceTypeId: serviceType.id,
      vehicleId: vehicle.id,
      bayId: bay.id,
      technicianId: technician.id,
      startAt,
      endAt,
    });

    const result = await this.deps.appointments.createWithReserve({
      dealershipId: input.dealershipId,
      serviceTypeId: serviceType.id,
      vehicleId: vehicle.id,
      customerId: customer.id,
      bayId: bay.id,
      technicianId: technician.id,
      startAt,
      endAt,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      holdMinutes: this.deps.holdMinutes ?? DEFAULT_HOLD_MINUTES,
      bufferMin: serviceType.bufferMin,
    });

    if (result.outcome === 'created') {
      appointmentOutcomes.inc({ outcome: 'created' });
      return { outcome: 'created', appointment: result.appointment };
    }
    if (result.outcome === 'duplicate') {
      appointmentOutcomes.inc({ outcome: 'duplicate' });
      return { outcome: 'duplicate', appointment: result.appointment };
    }
    if (result.outcome === 'idempotency_mismatch') {
      appointmentOutcomes.inc({ outcome: 'idempotency_mismatch' });
      return { outcome: 'idempotency_mismatch' };
    }

    appointmentOutcomes.inc({ outcome: 'conflict' });
    appointmentConflicts.inc();
    const nextAvailable = await this.searchSlots({
      dealershipId: input.dealershipId,
      serviceTypeCode: input.serviceTypeCode,
      vin: input.vin,
      desiredAt: input.startAt,
    }).catch(() => []);
    return { outcome: 'conflict', nextAvailable };
  }

  /** confirm transitions a held appointment to the confirmed state. */
  async confirm(appointmentId: string): Promise<Appointment> {
    return this.transition(appointmentId, ['HELD'], 'CONFIRMED', undefined, 'appointment is not in HELD state');
  }

  /** cancel transitions a held or confirmed appointment to the cancelled state. */
  async cancel(appointmentId: string): Promise<Appointment> {
    return this.transition(
      appointmentId,
      ['HELD', 'CONFIRMED'],
      'CANCELLED',
      { cancelledReason: 'cancelled_by_customer' },
      'appointment cannot be cancelled',
    );
  }

  /** complete transitions a confirmed appointment to completed. */
  async complete(appointmentId: string): Promise<Appointment> {
    return this.transition(
      appointmentId,
      ['CONFIRMED'],
      'COMPLETED',
      undefined,
      'appointment is not in CONFIRMED state',
    );
  }

  /** noShow transitions a confirmed appointment to no-show. */
  async noShow(appointmentId: string): Promise<Appointment> {
    return this.transition(
      appointmentId,
      ['CONFIRMED'],
      'NO_SHOW',
      undefined,
      'appointment is not in CONFIRMED state',
    );
  }

  /** transition loads the appointment, then applies a guarded status update. */
  private async transition(
    id: string,
    from: AppointmentStatus[],
    to: AppointmentStatus,
    extra?: { cancelledReason?: string },
    invalidMessage = 'invalid appointment transition',
  ): Promise<Appointment> {
    const existing = await this.deps.appointments.getById(id);
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'appointment not found');
    const updated = await this.deps.appointments.updateStatus(id, from, to, extra);
    if (!updated) throw new AppError(409, 'INVALID_TRANSITION', invalidMessage);
    return updated;
  }

  /** getAppointment returns the appointment for the given id, or null when none exists. */
  async getAppointment(id: string): Promise<Appointment | null> {
    return this.deps.appointments.getById(id);
  }

  /** releaseExpiredHolds releases holds whose TTL has elapsed and returns how many were freed. */
  async releaseExpiredHolds(): Promise<number> {
    const released = await this.deps.appointments.releaseExpiredHolds(this.now().toISOString());
    return released.length;
  }

  /** now returns the current instant from the injected clock, falling back to the wall clock. */
  private now(): Date {
    return (this.deps.clock ?? (() => new Date()))();
  }
}

/** invalid records the invalid-slot metric and builds an invalid-slot result. */
function invalid(reason: string): CreateAppointmentResult {
  appointmentOutcomes.inc({ outcome: 'invalid_slot' });
  return { outcome: 'invalid_slot', reason };
}

/** withinOpenHours reports whether a slot sits inside the dealership's local opening hours. */
function withinOpenHours(dealership: Dealership, start: Date, end: Date): boolean {
  const tz = dealership.timezone;
  if (!sameLocalDay(start, end, tz)) return false;
  const hours = dealership.hours.find((h) => h.weekday === localWeekday(start, tz));
  if (!hours) return false;
  const s = localMinuteOfDay(start, tz);
  const e = localMinuteOfDay(end, tz);
  return s >= hhMmToMinutes(hours.open) && e <= hhMmToMinutes(hours.close) && e > s;
}

/** withinShift reports whether a slot sits inside the technician's shift for the local weekday. */
function withinShift(technician: Technician, tz: string, start: Date, end: Date): boolean {
  if (!sameLocalDay(start, end, tz)) return false;
  const shift = technician.shifts.find((s) => s.weekday === localWeekday(start, tz));
  if (!shift) return false;
  const s = localMinuteOfDay(start, tz);
  const e = localMinuteOfDay(end, tz);
  return s >= hhMmToMinutes(shift.start) && e <= hhMmToMinutes(shift.end) && e > s;
}
