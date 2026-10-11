import { context, trace } from '@opentelemetry/api';

/**
 * OpenTelemetry wiring. The heavy SDK packages are required lazily inside
 * `initTracing` so importing this module (in tests, or from a handler that only
 * needs `currentTraceId`) stays side-effect free.
 */

let sdk: { shutdown(): Promise<void> } | undefined;

/** initTracing starts the OpenTelemetry SDK, exporting traces to the given OTLP endpoint when supplied. */
export function initTracing(otlpEndpoint?: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');

  const traceExporter = otlpEndpoint
    ? new OTLPTraceExporter({ url: `${otlpEndpoint.replace(/\/$/, '')}/v1/traces` })
    : undefined;

  const instance = new NodeSDK({
    ...(traceExporter ? { traceExporter } : {}),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });
  instance.start();
  sdk = instance;
}

/** shutdownTracing flushes and stops the OpenTelemetry SDK if it is running. */
export async function shutdownTracing(): Promise<void> {
  if (sdk) await sdk.shutdown();
}

/** currentTraceId returns the active span's trace id, or undefined when no SDK is running. */
export function currentTraceId(): string | undefined {
  return trace.getSpan(context.active())?.spanContext().traceId;
}
