import express, { type Express } from 'express';
import { errorHandler, notFoundHandler } from './common/errors';
import { requestContext } from './common/http';
import { httpMetricsMiddleware, metricsHandler } from './telemetry/metrics';

/**
 * Dependencies are injected so the app can be assembled with real adapters in
 * `server.ts` and with fakes in contract tests. Later tasks fill these in.
 */
export interface AppDeps {
  dbHealthy?: () => Promise<boolean>;
}

export function buildApp(deps: AppDeps = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(httpMetricsMiddleware());
  app.use(requestContext());

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/readyz', async (_req, res) => {
    let ready = true;
    try {
      if (deps.dbHealthy) ready = await deps.dbHealthy();
    } catch {
      ready = false;
    }
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
  });

  app.get('/metrics', metricsHandler());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
