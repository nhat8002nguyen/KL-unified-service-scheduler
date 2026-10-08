import knex from 'knex';
import { knexConfig } from './knexconfig';

/** Minimal migration CLI: `tsx src/db/cli.ts migrate|rollback`. */
async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  const db = knex(knexConfig());
  try {
    if (command === 'migrate') {
      const [batch, applied] = await db.migrate.latest();
      console.log(`migrate: batch ${batch}, ${applied.length} applied`);
    } else if (command === 'rollback') {
      const [batch, rolledBack] = await db.migrate.rollback();
      console.log(`rollback: batch ${batch}, ${rolledBack.length} rolled back`);
    } else {
      console.error('usage: tsx src/db/cli.ts <migrate|rollback>');
      process.exit(2);
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
