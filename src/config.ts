import { z } from 'zod';

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  LOG_LEVEL: z.string().default('info'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  HOLD_MINUTES: z.coerce.number().int().positive().default(10),
});

export interface Config {
  port: number;
  databaseUrl: string;
  logLevel: string;
  otlpEndpoint?: string;
  holdMinutes: number;
}

/**
 * Parse and validate process configuration. Throws on a missing/invalid value
 * so a misconfigured process fails fast at boot instead of mid-request.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${detail}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    logLevel: e.LOG_LEVEL,
    otlpEndpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT ? e.OTEL_EXPORTER_OTLP_ENDPOINT : undefined,
    holdMinutes: e.HOLD_MINUTES,
  };
}
