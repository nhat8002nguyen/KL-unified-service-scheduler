import type { BusyInterval, Slot } from '../availability/availability.types';
import type { AppointmentStatus } from '../domain/types';

/** The persistent appointment: the single record linking customer, vehicle, technician, bay, type, and time. */
export interface Appointment {
  id: string;
  dealershipId: string;
  customerId: string;
  vehicleId: string;
  serviceTypeId: string;
  bayId: string;
  technicianId: string;
  startAt: string;
  endAt: string;
  status: AppointmentStatus;
  holdExpiresAt: string | null;
  cancelledReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Read access to the diary's occupied windows. */
export interface AppointmentReader {
  busyIntervals(dealershipId: string, from: string, to: string): Promise<BusyInterval[]>;
}

export interface ReserveInput {
  dealershipId: string;
  serviceTypeId: string;
  vehicleId: string;
  customerId: string;
  bayId: string;
  technicianId: string;
  startAt: string;
  endAt: string;
  idempotencyKey: string;
  holdMinutes: number;
}

export type ReserveResult =
  | { outcome: 'created'; appointment: Appointment }
  | { outcome: 'duplicate'; appointment: Appointment }
  | { outcome: 'conflict' };

export interface AppointmentRepository extends AppointmentReader {
  createWithReserve(input: ReserveInput): Promise<ReserveResult>;
  updateStatus(
    id: string,
    from: AppointmentStatus[],
    to: AppointmentStatus,
    extra?: { cancelledReason?: string },
  ): Promise<Appointment | null>;
  releaseExpiredHolds(now: string): Promise<string[]>;
  getById(id: string): Promise<Appointment | null>;
}

export interface CustomerInput {
  name: string;
  phone?: string;
  email?: string;
}

export interface CustomerWriter {
  upsert(input: CustomerInput): Promise<{ id: string }>;
}

export interface SearchSlotsQuery {
  dealershipId: string;
  serviceTypeCode: string;
  vin: string;
  desiredAt: string;
  horizonDays?: number;
  limit?: number;
}

export interface CreateAppointmentInput {
  dealershipId: string;
  serviceTypeCode: string;
  vin: string;
  customer: CustomerInput;
  bayId: string;
  technicianId: string;
  startAt: string;
  endAt: string;
  idempotencyKey: string;
}

export type CreateAppointmentResult =
  | { outcome: 'created'; appointment: Appointment }
  | { outcome: 'duplicate'; appointment: Appointment }
  | { outcome: 'conflict'; nextAvailable: Slot[] }
  | { outcome: 'invalid_slot'; reason: string };

/** The scheduler's public surface. */
export interface BookingService {
  searchSlots(query: SearchSlotsQuery): Promise<Slot[]>;
  createAppointment(input: CreateAppointmentInput): Promise<CreateAppointmentResult>;
  confirm(appointmentId: string): Promise<Appointment>;
  cancel(appointmentId: string): Promise<Appointment>;
  getAppointment(id: string): Promise<Appointment | null>;
  /** Cancels every HELD appointment whose hold has expired; returns the count. */
  releaseExpiredHolds(): Promise<number>;
}
