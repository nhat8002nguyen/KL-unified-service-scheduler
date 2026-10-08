/** Shared domain primitives. */

/** A UUID identifier. */
export type Id = string;

/** Appointment lifecycle state (single record, updated in place). */
export type AppointmentStatus =
  | 'HELD'
  | 'CONFIRMED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'NO_SHOW';

export const APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
  'HELD',
  'CONFIRMED',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
];
