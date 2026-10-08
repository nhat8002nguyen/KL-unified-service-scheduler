import type { BookingService } from '../booking/booking.types';
import { logger } from '../telemetry/logger';

export const REAPER_INTERVAL_MS = 60_000;

/**
 * Periodically releases expired holds (HELD -> CANCELLED). The repository's
 * UPDATE only touches already-expired rows, so it is safe to run on more than
 * one instance. Also runnable as its own process (`src/jobs/reaper.ts`).
 */
export function startReaper(service: BookingService, intervalMs = REAPER_INTERVAL_MS): NodeJS.Timeout {
  const tick = (): void => {
    service
      .releaseExpiredHolds()
      .then((released) => {
        if (released > 0) logger.info({ released }, 'expired holds released');
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'hold reaper failed');
      });
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return timer;
}
