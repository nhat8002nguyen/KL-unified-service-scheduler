import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import { logger } from '../telemetry/logger';
import { currentTraceId } from '../telemetry/tracer';
import { AppError } from './errors';

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/** asyncHandler wraps an async handler so a rejected promise reaches the error middleware. */
export function asyncHandler(fn: Handler): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}

/** parseOrThrow validates untrusted input, raising a 422 with the issues on failure. */
export function parseOrThrow<T>(schema: ZodType<T>, data: unknown, what: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new AppError(422, 'VALIDATION_FAILED', `Invalid ${what}`, {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

export interface RequestLog {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

/** requestContext attaches a per-request logger carrying the trace id, and logs completion on finish. */
export function requestContext(): RequestHandler {
  return (req, res, next) => {
    const traceId = currentTraceId() ?? headerString(req.headers['x-request-id']);
    const ctx: Record<string, string> = {};
    if (traceId) ctx['trace_id'] = traceId;
    const log = logger.child(ctx);
    (req as Request & { log?: unknown }).log = log;

    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      log.info(
        {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration_ms: Math.round(ms),
        },
        'request',
      );
    });
    next();
  };
}

/** headerString collapses a possibly repeated header value to a single string. */
function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** headerValue reads a request header as a single string. */
export function headerValue(req: Request, name: string): string | undefined {
  return headerString(req.headers[name]);
}

/** pathParam reads a required path parameter as a string under Express 5's looser param types. */
export function pathParam(req: Request, name: string): string {
  const value: unknown = (req.params as Record<string, unknown>)[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  throw new AppError(400, 'VALIDATION_FAILED', `Missing path parameter "${name}"`);
}
