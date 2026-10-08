import type { AppointmentStatus } from '../domain/types';

/** Legal lifecycle transitions for a single appointment record, updated in place. */
export const ALLOWED_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  HELD: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['COMPLETED', 'CANCELLED', 'NO_SHOW'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

/** nextStates lists the legal target statuses reachable from the given status. */
export function nextStates(status: AppointmentStatus): AppointmentStatus[] {
  return [...ALLOWED_TRANSITIONS[status]];
}

/** canTransition reports whether moving from one status to another is a legal transition. */
export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
