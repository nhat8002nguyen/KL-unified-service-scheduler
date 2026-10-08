import { parseInstant } from '../common/time';
import { localDateOf, zoneOffsetMinutes, zonedWallClockUtc } from '../common/tz';
import { intersect, interval, minutes, subtractAll, union, type Interval } from './interval';
import type {
  AvailabilityContext,
  AvailabilityEngine,
  BusyInterval,
  Slot,
  SlotSearchInput,
} from './availability.types';

/** Score penalty (minutes) for landing in a non-preferred bay type. */
const PREFERRED_BAY_PENALTY = 60;

/**
 * Continuous-slot search. For each compatible (bay, technician) pair, intersect
 * the bay's open time with the technician's open time, subtract their busy
 * windows (each extended by the service buffer at the end), and emit one
 * duration-long candidate per free block. Output is advisory.
 */
export function findSlots(input: SlotSearchInput, ctx: AvailabilityContext): Slot[] {
  const tz = ctx.dealership.timezone;
  const desired = parseInstant(input.desiredAt);
  const now = input.now ? parseInstant(input.now) : new Date();

  const duration = input.serviceType.durationMin;
  const buffer = input.serviceType.bufferMin;

  const required = new Set(
    input.serviceType.bayTypes.filter((b) => b.kind === 'required').map((b) => b.bayTypeCode),
  );
  const preferred = new Set(
    input.serviceType.bayTypes.filter((b) => b.kind === 'preferred').map((b) => b.bayTypeCode),
  );

  const dealershipId = input.dealershipId;

  const bays = ctx.bays.filter(
    (b) =>
      b.active &&
      b.dealershipId === dealershipId &&
      (required.size === 0 || required.has(b.bayTypeCode)),
  );
  const technicians = ctx.technicians.filter(
    (t) => t.active && t.dealershipId === dealershipId,
  );

  const busyByBay = groupBusy(ctx.busy, 'bayId');
  const busyByTech = groupBusy(ctx.busy, 'technicianId');

  const slots: Slot[] = [];
  const startDay = localDateOf(now, tz);
  const nowMs = Math.floor(now.getTime() / 60_000) * 60_000;

  for (let dayOffset = 0; dayOffset <= input.horizonDays; dayOffset += 1) {
    const cal = new Date(Date.UTC(startDay.year, startDay.month - 1, startDay.day + dayOffset));
    const y = cal.getUTCFullYear();
    const mo = cal.getUTCMonth() + 1;
    const da = cal.getUTCDate();
    const weekday = cal.getUTCDay();

    const opening = union(
      ctx.dealership.hours
        .filter((h) => h.weekday === weekday)
        .map((h) => interval(zonedWallClockUtc(y, mo, da, h.open, tz), zonedWallClockUtc(y, mo, da, h.close, tz))),
    );
    if (opening.length === 0) continue;

    for (const bay of bays) {
      const bayOpen = subtractAll(opening, extendBuffer(busyByBay.get(bay.id) ?? [], buffer));
      if (bayOpen.length === 0) continue;

      for (const tech of technicians) {
        const shift = union(
          tech.shifts
            .filter((s) => s.weekday === weekday)
            .map((s) => interval(zonedWallClockUtc(y, mo, da, s.start, tz), zonedWallClockUtc(y, mo, da, s.end, tz))),
        );
        if (shift.length === 0) continue;

        const techOpen = subtractAll(shift, extendBuffer(busyByTech.get(tech.id) ?? [], buffer));
        if (techOpen.length === 0) continue;

        for (const free of intersect(bayOpen, techOpen)) {
          const earliest = Math.max(free.start.getTime(), nowMs);
          const latestStart = free.end.getTime() - duration * 60_000;
          if (latestStart < earliest) continue;

          // Anchor at the desired time when it fits the block, else at the earliest usable start.
          const startMs = Math.min(Math.max(desired.getTime(), earliest), latestStart);
          const isPreferred = preferred.has(bay.bayTypeCode);
          const score =
            Math.abs(startMs - desired.getTime()) / 60_000 +
            (isPreferred ? 0 : PREFERRED_BAY_PENALTY);

          slots.push({
            dealershipId,
            bayId: bay.id,
            technicianId: tech.id,
            startAt: new Date(startMs).toISOString(),
            endAt: new Date(startMs + duration * 60_000).toISOString(),
            preferredBay: isPreferred,
            score,
          });
        }
      }
    }
  }

  slots.sort((a, b) => a.score - b.score || Date.parse(a.startAt) - Date.parse(b.startAt));
  return slots.slice(0, input.limit);
}

function extendBuffer(busy: BusyInterval[], bufferMin: number): Interval[] {
  return busy.map((b) =>
    interval(parseInstant(b.startAt), new Date(parseInstant(b.endAt).getTime() + bufferMin * 60_000)),
  );
}

function groupBusy(busy: BusyInterval[], key: 'bayId' | 'technicianId'): Map<string, BusyInterval[]> {
  const map = new Map<string, BusyInterval[]>();
  for (const b of busy) {
    const list = map.get(b[key]);
    if (list) list.push(b);
    else map.set(b[key], [b]);
  }
  return map;
}

export const availabilityEngine: AvailabilityEngine = { findSlots };

// re-exported so consumers do not need to know the tz module
export { zoneOffsetMinutes };
