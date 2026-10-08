import type { AppointmentStatus } from '../domain/types';

/** Legal lifecycle transitions for a single appointment record, updated in place. */
export const ALLOWED_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  HELD: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['COMPLETED', 'CANCELLED', 'NO_SHOW'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

export function nextStates(status: AppointmentStatus): AppointmentStatus[] {
  return [...ALLOWED_TRANSITIONS[status]];
}

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
