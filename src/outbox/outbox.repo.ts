import { logger } from '../telemetry/logger';
import type { DbTx } from '../db/pool';
import type { DomainEvent, OutboxWriter } from './outbox.types';

/**
 * Writes the event into the `outbox` table in the caller's transaction, so the
 * event is atomic with the appointment write. The transport is a stub for the
 * MVP (a future publisher drains unpublished rows).
 */
export class PgOutboxWriter implements OutboxWriter {
  async append(tx: DbTx, event: DomainEvent): Promise<void> {
    await tx.query(
      'insert into outbox (aggregate_id, event_type, payload) values ($1, $2, $3)',
      [event.appointmentId, event.type, JSON.stringify(event)],
    );
    logger.debug({ event_type: event.type, appointment_id: event.appointmentId }, 'outbox append');
  }
}

/** No-op writer for tests that do not care about events. */
export class NoopOutboxWriter implements OutboxWriter {
  async append(): Promise<void> {
    /* no-op */
  }
}
