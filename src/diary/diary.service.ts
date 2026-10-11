import type { BusyInterval } from '../availability/availability.types';
import { AppError } from '../common/errors';
import { localDateOf, zonedWallClockUtc } from '../common/tz';
import type { Dealership, DealershipReader, BayReader, TechnicianReader } from '../resources/resources.types';
import type {
  CapacityAppointment,
  CapacitySummary,
  DiaryRepository,
  DiaryService,
  TechnicianCalendarEntry,
} from './diary.types';

export interface DiaryDeps {
  diary: DiaryRepository;
  dealerships: DealershipReader;
  bays: BayReader;
  technicians: TechnicianReader;
}

export class DiaryServiceImpl implements DiaryService {
  /** constructor stores the injected diary and resource readers. */
  constructor(private readonly deps: DiaryDeps) {}

  /** technicianCalendar returns a technician's appointments in the window, sorted by start time. */
  async technicianCalendar(
    technicianId: string,
    from: string,
    to: string,
  ): Promise<TechnicianCalendarEntry[]> {
    const entries = await this.deps.diary.technicianAppointments(technicianId, from, to);
    return entries
      .filter((e) => e.technicianId === technicianId)
      .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  }

  /** dealershipCapacity summarizes bay and technician utilization over the reporting window. */
  async dealershipCapacity(
    dealershipId: string,
    from: string,
    to: string,
  ): Promise<CapacitySummary> {
    const dealership = await this.deps.dealerships.getById(dealershipId);
    if (!dealership) {
      throw new AppError(404, 'NOT_FOUND', `Unknown dealership ${dealershipId}`);
    }

    const [bays, technicians, appointments] = await Promise.all([
      this.deps.bays.listByDealership(dealershipId),
      this.deps.technicians.listQualified(dealershipId, []),
      this.deps.diary.capacityAppointments(dealershipId, from, to),
    ]);

    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    const openMinutes = openMinutesInWindow(dealership, fromMs, toMs);
    const busyMinutes = (match: (a: CapacityAppointment) => boolean): number =>
      appointments.filter(match).reduce((sum, a) => sum + overlapMinutes(a, fromMs, toMs), 0);

    return {
      dealershipId,
      from,
      to,
      bays: bays.map((bay) => ({
        bayId: bay.id,
        bayName: bay.name,
        utilizationPct: utilization(busyMinutes((a) => a.bayId === bay.id), openMinutes),
        busy: busyIntervals(appointments, (a) => a.bayId === bay.id),
      })),
      technicians: technicians.map((tech) => ({
        technicianId: tech.id,
        name: tech.name,
        utilizationPct: utilization(busyMinutes((a) => a.technicianId === tech.id), openMinutes),
        busy: busyIntervals(appointments, (a) => a.technicianId === tech.id),
      })),
    };
  }
}

/** busyIntervals maps the appointments matching the predicate into busy intervals for the API. */
function busyIntervals(
  appointments: CapacityAppointment[],
  match: (a: CapacityAppointment) => boolean,
): BusyInterval[] {
  return appointments
    .filter(match)
    .map((a) => ({
      bayId: a.bayId,
      technicianId: a.technicianId,
      startAt: a.startAt,
      endAt: a.endAt,
    }));
}

/** overlapMinutes measures the minutes of an appointment that fall inside the reporting window. */
function overlapMinutes(a: CapacityAppointment, fromMs: number, toMs: number): number {
  const start = Math.max(Date.parse(a.startAt), fromMs);
  const end = Math.min(Date.parse(a.endAt), toMs);
  return end > start ? (end - start) / 60_000 : 0;
}

/** utilization returns busy time as a percentage of open time, rounded to one decimal. */
function utilization(busyMinutes: number, openMinutes: number): number {
  if (openMinutes <= 0) return 0;
  return Math.round((busyMinutes / openMinutes) * 1000) / 10;
}

/** openMinutesInWindow totals the dealership's open minutes that fall inside the reporting window. */
function openMinutesInWindow(dealership: Dealership, fromMs: number, toMs: number): number {
  const tz = dealership.timezone;
  const startDay = localDateOf(new Date(fromMs), tz);
  let total = 0;

  for (let i = 0; i <= 366; i += 1) {
    const cal = new Date(Date.UTC(startDay.year, startDay.month - 1, startDay.day + i));
    const y = cal.getUTCFullYear();
    const mo = cal.getUTCMonth() + 1;
    const da = cal.getUTCDate();

    if (Date.UTC(y, mo - 1, da) >= toMs) break;

    const hours = dealership.hours.find((h) => h.weekday === cal.getUTCDay());
    if (!hours) continue;

    const open = zonedWallClockUtc(y, mo, da, hours.open, tz).getTime();
    const close = zonedWallClockUtc(y, mo, da, hours.close, tz).getTime();
    const start = Math.max(open, fromMs);
    const end = Math.min(close, toMs);
    if (end > start) total += (end - start) / 60_000;
  }

  return total;
}
