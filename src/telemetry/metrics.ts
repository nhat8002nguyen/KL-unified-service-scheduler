import type { Request, RequestHandler } from 'express';
import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'scheduler_' });

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

/** Appointment creation outcomes: created | duplicate | idempotency_mismatch | conflict | invalid_slot. */
export const appointmentOutcomes = new client.Counter({
  name: 'appointments_total',
  help: 'Appointment creation outcomes',
  labelNames: ['outcome'],
  registers: [registry],
});

/** Commits rejected by a database exclusion constraint (stale search / lost race). */
export const appointmentConflicts = new client.Counter({
  name: 'appointment_conflicts_total',
  help: 'Booking attempts rejected because the requested slot was already taken',
  registers: [registry],
});

export const slotSearchDuration = new client.Histogram({
  name: 'slot_search_duration_seconds',
  help: 'Slot search duration in seconds',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
  registers: [registry],
});

/** routeLabel derives the metric route label from the matched Express route, or 'unmatched'. */
function routeLabel(req: Request): string {
  const route = (req as unknown as { route?: { path?: unknown } }).route;
  const path = route?.path;
  if (typeof path === 'string') return path;
  if (Array.isArray(path) && typeof path[0] === 'string') return path[0];
  return 'unmatched';
}

/** httpMetricsMiddleware records request duration and count per route, skipping the /metrics endpoint. */
export function httpMetricsMiddleware(): RequestHandler {
  return (req, res, next) => {
    if (req.path === '/metrics') {
      next();
      return;
    }
    const end = httpRequestDuration.startTimer();
    res.on('finish', () => {
      const labels = {
        method: req.method,
        route: routeLabel(req),
        status: String(res.statusCode),
      };
      end(labels);
      httpRequestsTotal.inc(labels);
    });
    next();
  };
}

/** metricsHandler serves the Prometheus registry as the /metrics response body. */
export function metricsHandler(): RequestHandler {
  return (_req, res) => {
    res.setHeader('Content-Type', registry.contentType);
    void registry.metrics().then((body) => res.end(body));
  };
}
