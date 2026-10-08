import { buildApp } from './app';
import { PgAppointmentRepo, PgCustomerRepo } from './booking/booking.repo';
import { BookingServiceImpl } from './booking/booking.service';
import { PgCatalogRepo } from './catalog/catalog.repo';
import { loadConfig } from './config';
import { createPool } from './db/pool';
import { PgDiaryRepo } from './diary/diary.repo';
import { DiaryServiceImpl } from './diary/diary.service';
import { startReaper } from './jobs/reaper';
import { PgOutboxWriter } from './outbox/outbox.repo';
import { PgResourcesRepo } from './resources/resources.repo';
import { logger } from './telemetry/logger';
import { initTracing, shutdownTracing } from './telemetry/tracer';

/**
 * Composition root: the only place that picks concrete adapters and wires them
 * into the modules. Every module talks to an interface, so each adapter can be
 * swapped for an HTTP client when the module is extracted into a service.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  initTracing(config.otlpEndpoint);

  const pool = createPool(config.databaseUrl);

  const outbox = new PgOutboxWriter();
  const catalog = new PgCatalogRepo(pool);
  const resources = new PgResourcesRepo(pool);
  const appointments = new PgAppointmentRepo(pool, outbox);
  const customers = new PgCustomerRepo(pool);

  const booking = new BookingServiceImpl({
    catalog,
    vehicles: resources,
    dealerships: resources,
    bays: resources,
    technicians: resources,
    customers,
    appointments,
    holdMinutes: config.holdMinutes,
  });

  const diary = new DiaryServiceImpl({
    diary: new PgDiaryRepo(pool),
    dealerships: resources,
    bays: resources,
    technicians: resources,
  });

  const app = buildApp({
    catalog,
    resources: { vehicles: resources, dealerships: resources, bays: resources, technicians: resources },
    booking,
    diary,
    dbHealthy: async () => {
      await pool.query('select 1');
      return true;
    },
  });

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'scheduler listening');
  });

  const reaper = startReaper(booking);
  logger.info('hold reaper started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    clearInterval(reaper);
    server.close();
    await shutdownTracing();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
