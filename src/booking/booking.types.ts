import type { BusyInterval, Slot } from '../availability/availability.types';

/** Read access to the diary's occupied windows. Implemented in Task 6. */
export interface AppointmentReader {
  busyIntervals(dealershipId: string, from: string, to: string): Promise<BusyInterval[]>;
}

export interface SearchSlotsQuery {
  dealershipId: string;
  serviceTypeCode: string;
  vin: string;
  desiredAt: string;
  horizonDays?: number;
  limit?: number;
}

/** The scheduler's public surface. Grows in Tasks 6–7. */
export interface BookingService {
  searchSlots(query: SearchSlotsQuery): Promise<Slot[]>;
}
