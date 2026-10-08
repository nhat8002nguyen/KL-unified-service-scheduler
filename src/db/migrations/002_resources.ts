import type { Knex } from 'knex';

/** up creates the resource tables: dealerships, hours, bays, technicians, shifts, vehicles, and customers. */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('dealership', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('name').notNullable();
    t.text('timezone').notNullable();
  });

  await knex.schema.createTable('dealership_hours', (t) => {
    t.uuid('dealership_id').notNullable().references('id').inTable('dealership').onDelete('CASCADE');
    t.integer('weekday').notNullable();
    t.time('open_time').notNullable();
    t.time('close_time').notNullable();
    t.primary(['dealership_id', 'weekday']);
  });
  await knex.raw(
    'alter table dealership_hours add constraint dealership_hours_weekday_check check (weekday between 0 and 6)',
  );

  await knex.schema.createTable('service_bay', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('dealership_id').notNullable().references('id').inTable('dealership').onDelete('CASCADE');
    t.text('name').notNullable();
    t.uuid('bay_type_id').notNullable().references('id').inTable('bay_type');
    t.boolean('active').notNullable().defaultTo(true);
  });

  await knex.schema.createTable('technician', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('dealership_id').notNullable().references('id').inTable('dealership').onDelete('CASCADE');
    t.text('name').notNullable();
    t.boolean('active').notNullable().defaultTo(true);
  });

  await knex.schema.createTable('technician_skill', (t) => {
    t.uuid('technician_id').notNullable().references('id').inTable('technician').onDelete('CASCADE');
    t.uuid('skill_id').notNullable().references('id').inTable('skill').onDelete('CASCADE');
    t.integer('proficiency').notNullable().defaultTo(1);
    t.primary(['technician_id', 'skill_id']);
  });

  await knex.schema.createTable('technician_shift', (t) => {
    t.uuid('technician_id').notNullable().references('id').inTable('technician').onDelete('CASCADE');
    t.integer('weekday').notNullable();
    t.time('start_time').notNullable();
    t.time('end_time').notNullable();
    t.primary(['technician_id', 'weekday']);
  });
  await knex.raw(
    'alter table technician_shift add constraint technician_shift_weekday_check check (weekday between 0 and 6)',
  );

  await knex.schema.createTable('vehicle', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('vin').notNullable().unique();
    t.text('make').notNullable();
    t.text('model').notNullable();
    t.integer('year').notNullable();
  });

  await knex.schema.createTable('customer', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('name').notNullable();
    t.text('phone');
    t.text('email');
  });
}

/** down drops the resource tables in reverse dependency order. */
export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('customer');
  await knex.schema.dropTableIfExists('vehicle');
  await knex.schema.dropTableIfExists('technician_shift');
  await knex.schema.dropTableIfExists('technician_skill');
  await knex.schema.dropTableIfExists('technician');
  await knex.schema.dropTableIfExists('service_bay');
  await knex.schema.dropTableIfExists('dealership_hours');
  await knex.schema.dropTableIfExists('dealership');
}
