import { buildApp } from './app';
import { loadConfig } from './config';
import { createPool } from './db/pool';
import { logger } from './telemetry/logger';
import { initTracing, shutdownTracing } from './telemetry/tracer';

async function main(): Promise<void> {
  const config = loadConfig();
  initTracing(config.otlpEndpoint);

  const pool = createPool(config.databaseUrl);
  const app = buildApp({
    dbHealthy: async () => {
      await pool.query('select 1');
      return true;
    },
  });

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'scheduler listening');
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
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
