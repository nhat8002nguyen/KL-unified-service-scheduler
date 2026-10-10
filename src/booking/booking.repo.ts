import type { BusyInterval } from '../availability/availability.types';
import type { Db } from '../db/pool';
import type { AppointmentStatus } from '../domain/types';
import type { OutboxWriter } from '../outbox/outbox.types';
import type {
  Appointment,
  AppointmentRepository,
  CustomerInput,
  CustomerWriter,
  ReserveInput,
  ReserveResult,
} from './booking.types';

interface AppointmentRow {
  id: string;
  dealership_id: string;
  customer_id: string;
  vehicle_id: string;
  service_type_id: string;
  service_bay_id: string;
  technician_id: string;
  start_at: Date;
  end_at: Date;
  status: AppointmentStatus;
  hold_expires_at: Date | null;
  cancelled_reason: string | null;
  request_fingerprint: string;
  created_at: Date;
  updated_at: Date;
}

/** mapAppointment converts a raw appointment row into its domain shape. */
function mapAppointment(row: AppointmentRow): Appointment {
  return {
    id: row.id,
    dealershipId: row.dealership_id,
    customerId: row.customer_id,
    vehicleId: row.vehicle_id,
    serviceTypeId: row.service_type_id,
    bayId: row.service_bay_id,
    technicianId: row.technician_id,
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
    status: row.status,
    holdExpiresAt: row.hold_expires_at ? row.hold_expires_at.toISOString() : null,
    cancelledReason: row.cancelled_reason,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

interface PgError {
  code?: string;
}

const EXCLUSION_VIOLATION = '23P01';

interface SqlClient {
  query<T = unknown>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

/** resolveActiveIdempotency returns duplicate/mismatch for a live HELD/CONFIRMED key, or null when free. */
async function resolveActiveIdempotency(
  client: SqlClient,
  input: ReserveInput,
): Promise<ReserveResult | null> {
  const existing = await client.query<AppointmentRow>(
    `select * from appointment
      where dealership_id = $1
        and idempotency_key = $2
        and (
          status = 'CONFIRMED'
          or (status = 'HELD' and (hold_expires_at is null or hold_expires_at >= now()))
        )
      limit 1`,
    [input.dealershipId, input.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) return null;
  if (row.request_fingerprint === input.requestFingerprint) {
    return { outcome: 'duplicate', appointment: mapAppointment(row) };
  }
  return { outcome: 'idempotency_mismatch' };
}

export class PgAppointmentRepo implements AppointmentRepository {
  /** constructor stores the database pool and outbox writer. */
  constructor(
    private readonly db: Db,
    private readonly outbox: OutboxWriter,
  ) {}

  /** busyIntervals returns the bay and technician windows held or confirmed for a dealership within a range. */
  async busyIntervals(dealershipId: string, from: string, to: string): Promise<BusyInterval[]> {
    const { rows } = await this.db.query<{
      service_bay_id: string;
      technician_id: string;
      start_at: Date;
      end_at: Date;
    }>(
      `select service_bay_id, technician_id, start_at, end_at
         from appointment
        where dealership_id = $1
          and (
            status = 'CONFIRMED'
            or (status = 'HELD' and (hold_expires_at is null or hold_expires_at >= now()))
          )
          and tstzrange(start_at, end_at) && tstzrange($2::timestamptz, $3::timestamptz)`,
      [dealershipId, from, to],
    );
    return rows.map((r) => ({
      bayId: r.service_bay_id,
      technicianId: r.technician_id,
      startAt: r.start_at.toISOString(),
      endAt: r.end_at.toISOString(),
    }));
  }

  /** getById loads a single appointment by id, or null when none exists. */
  async getById(id: string): Promise<Appointment | null> {
    const { rows } = await this.db.query<AppointmentRow>(
      'select * from appointment where id = $1 limit 1',
      [id],
    );
    const row = rows[0];
    return row ? mapAppointment(row) : null;
  }

  /** createWithReserve atomically reserves a bay and technician and creates the appointment.
   * It first honors active-key idempotency (with fingerprint checks), then locks both resources
   * and re-checks availability to stay conflict-free.
   * Returns the created appointment, an existing duplicate, a fingerprint mismatch, or a conflict. */
  async createWithReserve(input: ReserveInput): Promise<ReserveResult> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const early = await resolveActiveIdempotency(client, input);
      if (early) {
        await client.query('ROLLBACK');
        return early;
      }

      // Serialize competitors for the same two resources before inserting.
      await client.query('select id from service_bay where id = $1 for update', [input.bayId]);
      await client.query('select id from technician where id = $1 for update', [input.technicianId]);

      // Re-check idempotency now that we hold the locks: a concurrent same-key
      // submit has either committed (visible now) or is queued behind us.
      const raced = await resolveActiveIdempotency(client, input);
      if (raced) {
        await client.query('ROLLBACK');
        return raced;
      }

      // Exclusion constraints still treat expired HELD as occupying capacity, so
      // cancel overlapping expired holds in this TX before clash/insert.
      const expired = await client.query<{ id: string }>(
        `update appointment
            set status = 'CANCELLED',
                cancelled_reason = 'hold_expired',
                updated_at = now()
          where dealership_id = $1
            and status = 'HELD'
            and hold_expires_at < now()
            and (
              idempotency_key = $6
              or (
                (service_bay_id = $2 or technician_id = $3)
                and tstzrange(start_at, end_at) && tstzrange($4::timestamptz, $5::timestamptz)
              )
            )
          returning id`,
        [
          input.dealershipId,
          input.bayId,
          input.technicianId,
          input.startAt,
          input.endAt,
          input.idempotencyKey,
        ],
      );
      const expiredAt = new Date().toISOString();
      for (const row of expired.rows) {
        await this.outbox.append(client, {
          type: 'AppointmentCancelled',
          appointmentId: row.id,
          occurredAt: expiredAt,
        });
      }

      // Re-verify both resources are still free for the full window, extending
      // each busy end by the service buffer (same semantics as findSlots).
      const clash = await client.query(
        `select 1 from appointment
          where dealership_id = $1
            and (
              status = 'CONFIRMED'
              or (status = 'HELD' and (hold_expires_at is null or hold_expires_at >= now()))
            )
            and (service_bay_id = $2 or technician_id = $3)
            and tstzrange(start_at, end_at + make_interval(mins => $6::int))
                && tstzrange($4::timestamptz, $5::timestamptz)
          limit 1`,
        [
          input.dealershipId,
          input.bayId,
          input.technicianId,
          input.startAt,
          input.endAt,
          input.bufferMin,
        ],
      );
      if (clash.rowCount && clash.rowCount > 0) {
        await client.query('ROLLBACK');
        return { outcome: 'conflict' };
      }

      const inserted = await client.query<AppointmentRow>(
        `insert into appointment
           (dealership_id, customer_id, vehicle_id, service_type_id, service_bay_id, technician_id,
            start_at, end_at, status, hold_expires_at, idempotency_key, request_fingerprint)
         values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, 'HELD',
                 now() + make_interval(mins => $9::int), $10, $11)
         on conflict (dealership_id, idempotency_key) where (status in ('HELD','CONFIRMED'))
         do nothing
         returning *`,
        [
          input.dealershipId,
          input.customerId,
          input.vehicleId,
          input.serviceTypeId,
          input.bayId,
          input.technicianId,
          input.startAt,
          input.endAt,
          input.holdMinutes,
          input.idempotencyKey,
          input.requestFingerprint,
        ],
      );

      if (inserted.rowCount === 0) {
        const conflicted = await resolveActiveIdempotency(client, input);
        await client.query('ROLLBACK');
        return conflicted ?? { outcome: 'conflict' };
      }

      const row = inserted.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return { outcome: 'conflict' };
      }
      const appointment = mapAppointment(row);
      await this.outbox.append(client, {
        type: 'AppointmentHeld',
        appointmentId: appointment.id,
        occurredAt: new Date().toISOString(),
      });
      await client.query('COMMIT');
      return { outcome: 'created', appointment };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if ((err as PgError).code === EXCLUSION_VIOLATION) {
        return { outcome: 'conflict' };
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /** updateStatus transitions an appointment when its current status is among the allowed `from` values. */
  async updateStatus(
    id: string,
    from: AppointmentStatus[],
    to: AppointmentStatus,
    extra?: { cancelledReason?: string },
  ): Promise<Appointment | null> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query<AppointmentRow>(
        `update appointment
            set status = $3,
                cancelled_reason = coalesce($4, cancelled_reason),
                hold_expires_at = case when $3 = 'CONFIRMED' then null else hold_expires_at end,
                updated_at = now()
          where id = $1 and status = any($2::text[])
          returning *`,
        [id, from, to, extra?.cancelledReason ?? null],
      );
      const row = updated.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return null;
      }
      const appointment = mapAppointment(row);
      await this.outbox.append(client, {
        type: statusEvent(to),
        appointmentId: id,
        occurredAt: new Date().toISOString(),
      });
      await client.query('COMMIT');
      return appointment;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** releaseExpiredHolds cancels held appointments whose hold window has lapsed and returns their ids. */
  async releaseExpiredHolds(now: string): Promise<string[]> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const released = await client.query<{ id: string }>(
        `update appointment
            set status = 'CANCELLED', cancelled_reason = 'hold_expired', updated_at = now()
          where status = 'HELD' and hold_expires_at < $1::timestamptz
          returning id`,
        [now],
      );
      const occurredAt = new Date().toISOString();
      for (const row of released.rows) {
        await this.outbox.append(client, {
          type: 'AppointmentCancelled',
          appointmentId: row.id,
          occurredAt,
        });
      }
      await client.query('COMMIT');
      return released.rows.map((r) => r.id);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

/** statusEvent maps an appointment status to its corresponding outbox event type. */
function statusEvent(status: AppointmentStatus): 'AppointmentConfirmed' | 'AppointmentCancelled' | 'AppointmentCompleted' | 'AppointmentNoShow' | 'AppointmentHeld' {
  switch (status) {
    case 'CONFIRMED':
      return 'AppointmentConfirmed';
    case 'CANCELLED':
      return 'AppointmentCancelled';
    case 'COMPLETED':
      return 'AppointmentCompleted';
    case 'NO_SHOW':
      return 'AppointmentNoShow';
    default:
      return 'AppointmentHeld';
  }
}

export class PgCustomerRepo implements CustomerWriter {
  /** constructor stores the database pool used to read and write customers. */
  constructor(private readonly db: Db) {}

  /** upsert inserts a customer or updates the existing row matched by unique email. */
  async upsert(input: CustomerInput): Promise<{ id: string }> {
    if (!input.email) {
      const inserted = await this.db.query<{ id: string }>(
        'insert into customer (name, phone, email) values ($1, $2, null) returning id',
        [input.name, input.phone ?? null],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('customer insert returned no row');
      return { id: row.id };
    }

    const upserted = await this.db.query<{ id: string }>(
      `insert into customer (name, phone, email)
       values ($1, $2, $3)
       on conflict (email) where (email is not null)
       do update set
         name = excluded.name,
         phone = coalesce(excluded.phone, customer.phone)
       returning id`,
      [input.name, input.phone ?? null, input.email],
    );
    const row = upserted.rows[0];
    if (!row) throw new Error('customer upsert returned no row');
    return { id: row.id };
  }
}
