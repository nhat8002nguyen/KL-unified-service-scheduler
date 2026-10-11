import type { ErrorRequestHandler, RequestHandler } from 'express';
import { logger } from '../telemetry/logger';

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'SLOT_TAKEN'
  | 'INVALID_SLOT'
  | 'INVALID_TRANSITION'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL';

/** An error with a known HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  /** constructor stores the HTTP status, the stable error code, and any details. */
  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** notFoundHandler replies 404 for any request that matched no route. */
export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` });
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
/** errorHandler renders a thrown AppError as JSON with its status and code, and anything else as a generic 500. */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    const body: Record<string, unknown> = { error: err.code, message: err.message };
    if (err.details !== undefined) body['details'] = err.details;
    logger.warn(
      { code: err.code, status: err.status, message: err.message },
      'request failed',
    );
    res.status(err.status).json(body);
    return;
  }
  logger.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'INTERNAL', message: 'Internal server error' });
};
