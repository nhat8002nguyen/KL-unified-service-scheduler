import type { Knex } from 'knex';

/** up adds request fingerprints, active-only idempotency uniqueness, and unique customer emails. */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    alter table appointment
      add column if not exists request_fingerprint text not null default ''
  `);

  // Drop the permanent unique constraint (auto-named by Postgres from 003).
  await knex.raw(`
    alter table appointment
      drop constraint if exists appointment_dealership_id_idempotency_key_key
  `);

  await knex.raw(`
    create unique index if not exists appointment_active_idempotency_uidx
      on appointment (dealership_id, idempotency_key)
      where status in ('HELD', 'CONFIRMED')
  `);

  // Multiple NULLs remain allowed; only non-null emails must be unique.
  await knex.raw(`
    create unique index if not exists customer_email_uidx
      on customer (email)
      where email is not null
  `);
}

/** down restores the permanent idempotency unique constraint and drops the new indexes/column. */
export async function down(knex: Knex): Promise<void> {
  await knex.raw('drop index if exists customer_email_uidx');
  await knex.raw('drop index if exists appointment_active_idempotency_uidx');
  await knex.raw(`
    alter table appointment
      add constraint appointment_dealership_id_idempotency_key_key
      unique (dealership_id, idempotency_key)
  `);
  await knex.raw('alter table appointment drop column if exists request_fingerprint');
}
