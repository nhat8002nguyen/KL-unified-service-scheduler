import type { BusyInterval } from '../availability/availability.types';
import type { AppointmentStatus } from '../domain/types';

/** One row on a technician's calendar. */
export interface TechnicianCalendarEntry {
  appointmentId: string;
  technicianId: string;
  startAt: string;
  endAt: string;
  status: AppointmentStatus;
  serviceTypeCode: string;
  vehicleVin: string;
  bayName: string;
}

/** A diary row reduced to what capacity math needs. */
export interface CapacityAppointment {
  appointmentId: string;
  bayId: string;
  technicianId: string;
  startAt: string;
  endAt: string;
}

export interface DiaryRepository {
  technicianAppointments(
    technicianId: string,
    from: string,
    to: string,
  ): Promise<TechnicianCalendarEntry[]>;
  capacityAppointments(
    dealershipId: string,
    from: string,
    to: string,
  ): Promise<CapacityAppointment[]>;
}

export interface BayCapacity {
  bayId: string;
  bayName: string;
  utilizationPct: number;
  busy: BusyInterval[];
}

export interface TechnicianCapacity {
  technicianId: string;
  name: string;
  utilizationPct: number;
  busy: BusyInterval[];
}

export interface CapacitySummary {
  dealershipId: string;
  from: string;
  to: string;
  bays: BayCapacity[];
  technicians: TechnicianCapacity[];
}

export interface DiaryService {
  technicianCalendar(
    technicianId: string,
    from: string,
    to: string,
  ): Promise<TechnicianCalendarEntry[]>;
  dealershipCapacity(dealershipId: string, from: string, to: string): Promise<CapacitySummary>;
}
