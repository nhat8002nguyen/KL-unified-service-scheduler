import type { Knex } from 'knex';

const PARTITIONS = 4;

/** up creates the hash-partitioned appointment diary, its partial exclusion constraints, and the outbox. */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create table appointment (
      dealership_id uuid not null references dealership(id),
      id uuid not null default gen_random_uuid(),
      customer_id uuid not null references customer(id),
      vehicle_id uuid not null references vehicle(id),
      service_type_id uuid not null references service_type(id),
      service_bay_id uuid not null references service_bay(id),
      technician_id uuid not null references technician(id),
      start_at timestamptz not null,
      end_at timestamptz not null,
      status text not null check (status in ('HELD','CONFIRMED','COMPLETED','CANCELLED','NO_SHOW')),
      hold_expires_at timestamptz,
      cancelled_reason text,
      idempotency_key text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check (end_at > start_at),
      primary key (dealership_id, id),
      unique (dealership_id, idempotency_key)
    ) partition by hash (dealership_id)
  `);

  for (let i = 0; i < PARTITIONS; i += 1) {
    await knex.raw(
      `create table appointment_p${i} partition of appointment for values with (modulus ${PARTITIONS}, remainder ${i})`,
    );
  }

  // Partial exclusion constraints: only active rows occupy a resource, so a
  // CANCELLED/COMPLETED/NO_SHOW appointment frees its interval for rebooking.
  await knex.raw(`
    alter table appointment add constraint no_bay_overlap
      exclude using gist (dealership_id with =, service_bay_id with =, tstzrange(start_at, end_at) with &&)
      where (status in ('HELD','CONFIRMED'))
  `);
  await knex.raw(`
    alter table appointment add constraint no_tech_overlap
      exclude using gist (dealership_id with =, technician_id with =, tstzrange(start_at, end_at) with &&)
      where (status in ('HELD','CONFIRMED'))
  `);

  await knex.raw(
    'create index appointment_dealership_time_idx on appointment (dealership_id, start_at, end_at)',
  );
  await knex.raw(
    "create index appointment_status_idx on appointment (status) where status = 'HELD'",
  );

  await knex.raw(`
    create table outbox (
      id bigserial primary key,
      aggregate_id uuid not null,
      event_type text not null,
      payload jsonb not null,
      occurred_at timestamptz not null default now(),
      published_at timestamptz
    )
  `);
}

/** down drops the outbox and appointment tables. */
export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('outbox');
  await knex.schema.dropTableIfExists('appointment');
}
