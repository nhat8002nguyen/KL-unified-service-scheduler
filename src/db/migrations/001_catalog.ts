import type { Knex } from 'knex';

/** up creates the catalog tables: skills, bay types, service types, and their rules. */
export async function up(knex: Knex): Promise<void> {
  await knex.raw('create extension if not exists pgcrypto');
  await knex.raw('create extension if not exists btree_gist');

  await knex.schema.createTable('skill', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('code').notNullable().unique();
    t.text('name').notNullable();
  });

  await knex.schema.createTable('bay_type', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('code').notNullable().unique();
    t.text('name').notNullable();
  });

  await knex.schema.createTable('service_type', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('code').notNullable().unique();
    t.text('name').notNullable();
    t.integer('duration_min').notNullable();
    t.integer('buffer_min').notNullable().defaultTo(0);
  });

  await knex.schema.createTable('service_type_required_skill', (t) => {
    t.uuid('service_type_id').notNullable().references('id').inTable('service_type').onDelete('CASCADE');
    t.uuid('skill_id').notNullable().references('id').inTable('skill').onDelete('CASCADE');
    t.integer('min_proficiency').notNullable().defaultTo(1);
    t.primary(['service_type_id', 'skill_id']);
  });

  await knex.schema.createTable('service_type_bay_type', (t) => {
    t.uuid('service_type_id').notNullable().references('id').inTable('service_type').onDelete('CASCADE');
    t.uuid('bay_type_id').notNullable().references('id').inTable('bay_type').onDelete('CASCADE');
    t.text('kind').notNullable();
    t.primary(['service_type_id', 'bay_type_id']);
  });
  await knex.raw(
    `alter table service_type_bay_type add constraint service_type_bay_type_kind_check check (kind in ('required','preferred'))`,
  );
}

/** down drops the catalog tables in reverse dependency order. */
export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('service_type_bay_type');
  await knex.schema.dropTableIfExists('service_type_required_skill');
  await knex.schema.dropTableIfExists('service_type');
  await knex.schema.dropTableIfExists('bay_type');
  await knex.schema.dropTableIfExists('skill');
}
