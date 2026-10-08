import type { DbTx } from '../db/pool';

export type DomainEventType =
  | 'AppointmentHeld'
  | 'AppointmentConfirmed'
  | 'AppointmentCancelled'
  | 'AppointmentCompleted'
  | 'AppointmentNoShow';

export interface DomainEvent {
  type: DomainEventType;
  appointmentId: string;
  occurredAt: string;
  [key: string]: unknown;
}

/** Appends an event to the outbox inside the caller's transaction. */
export interface OutboxWriter {
  append(tx: DbTx, event: DomainEvent): Promise<void>;
}
