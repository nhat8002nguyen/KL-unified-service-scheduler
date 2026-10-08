import { findSlots } from '../availability/availability.engine';
import type { Slot } from '../availability/availability.types';
import type { CatalogReader } from '../catalog/catalog.types';
import { AppError } from '../common/errors';
import type { DealershipReader, BayReader, TechnicianReader, VehicleReader } from '../resources/resources.types';
import type { AppointmentReader, BookingService, SearchSlotsQuery } from './booking.types';

export interface BookingDeps {
  catalog: CatalogReader;
  vehicles: VehicleReader;
  dealerships: DealershipReader;
  bays: BayReader;
  technicians: TechnicianReader;
  appointments: AppointmentReader;
  /** Injectable clock for deterministic tests. */
  clock?: () => Date;
}

const DEFAULT_HORIZON_DAYS = 7;
const DEFAULT_LIMIT = 10;

export class BookingServiceImpl implements BookingService {
  constructor(private readonly deps: BookingDeps) {}

  async searchSlots(query: SearchSlotsQuery): Promise<Slot[]> {
    const now = (this.deps.clock ?? (() => new Date()))();
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
    if (!serviceType) {
      throw new AppError(404, 'NOT_FOUND', `Unknown service type ${query.serviceTypeCode}`);
    }
    if (!vehicle) {
      throw new AppError(404, 'NOT_FOUND', `Unknown VIN ${query.vin}`);
    }
    if (!dealership) {
      throw new AppError(404, 'NOT_FOUND', `Unknown dealership ${query.dealershipId}`);
    }

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
}
