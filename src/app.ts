import express, { type Express, type RequestHandler } from 'express';
import { catalogRouter } from './catalog/catalog.router';
import type { CatalogRepository } from './catalog/catalog.types';
import { errorHandler, notFoundHandler } from './common/errors';
import { requestContext } from './common/http';
import { resourcesRouter, type ResourcesDeps } from './resources/resources.router';
import { httpMetricsMiddleware, metricsHandler } from './telemetry/metrics';

/**
 * Dependencies are injected so the app can be assembled with real adapters in
 * `server.ts` and with fakes in contract tests. A dependency left undefined
 * mounts a 501 stub, so partial apps stay callable.
 */
export interface AppDeps {
  dbHealthy?: () => Promise<boolean>;
  catalog?: CatalogRepository;
  resources?: ResourcesDeps;
}

const notImplemented: RequestHandler = (req, res) => {
  res.status(501).json({ error: 'NOT_IMPLEMENTED', message: `${req.method} ${req.path} not wired` });
};

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

  if (deps.catalog) {
    app.use(catalogRouter(deps.catalog));
  } else {
    app.get('/service-types', notImplemented);
  }

  if (deps.resources) {
    app.use(resourcesRouter(deps.resources));
  } else {
    app.get('/dealerships/:id', notImplemented);
    app.get('/vehicles/:vin', notImplemented);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
