import pino, { type Logger } from 'pino';

/** Root structured logger (JSON lines). */
export const logger: Logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: ['req.headers.authorization', 'authorization'], remove: true },
});

export interface LogContext {
  trace_id?: string;
  dealership_id?: string;
  appointment_id?: string;
}

/** childLogger returns a logger bound to a request/event context. */
export function childLogger(ctx: LogContext): Logger {
  return logger.child(ctx);
}
