import type { ServiceTypeDetail } from '../catalog/catalog.types';
import type { Dealership, ServiceBay, Technician } from '../resources/resources.types';

/** A candidate booking window. Advisory only; the DB decides at commit. */
export interface Slot {
  dealershipId: string;
  bayId: string;
  technicianId: string;
  startAt: string;
  endAt: string;
  preferredBay: boolean;
  score: number;
}

export interface SlotSearchInput {
  dealershipId: string;
  serviceType: ServiceTypeDetail;
  desiredAt: string;
  horizonDays: number;
  limit: number;
  /** Injectable clock (ISO UTC) for deterministic tests. */
  now?: string;
}

/** An occupied window on one bay and one technician. */
export interface BusyInterval {
  bayId: string;
  technicianId: string;
  startAt: string;
  endAt: string;
}

/** Everything the engine needs; the caller resolves it from the readers. */
export interface AvailabilityContext {
  dealership: Dealership;
  bays: ServiceBay[];
  technicians: Technician[];
  busy: BusyInterval[];
}

export interface AvailabilityEngine {
  findSlots(input: SlotSearchInput, ctx: AvailabilityContext): Slot[];
}
