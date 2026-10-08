import knex from 'knex';
import { knexConfig } from './knexconfig';

/** Apply all migrations, then run the seed. Used by the container entrypoint. */
async function main(): Promise<void> {
  const db = knex(knexConfig());
  try {
    const [batch, applied] = await db.migrate.latest();
    console.log(`migrations: batch ${batch}, ${applied.length} applied`);
    const [seeded] = await db.seed.run();
    console.log(`seeds: ${seeded.length} file(s)`);
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
