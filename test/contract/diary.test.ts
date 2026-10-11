import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/app';
import { DiaryServiceImpl } from '../../src/diary/diary.service';
import type { DiaryRepository, TechnicianCalendarEntry } from '../../src/diary/diary.types';
import type { Dealership, ServiceBay, Technician } from '../../src/resources/resources.types';

const from = '2030-01-07T00:00:00.000Z';
const to = '2030-01-09T00:00:00.000Z';
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

const dealership: Dealership = {
  id: 'd1', name: 'Demo', timezone: 'UTC',
  hours: WEEKDAYS.map((weekday) => ({ weekday, open: '08:00', close: '18:00' })),
};
const bays: ServiceBay[] = [{ id: 'b1', dealershipId: 'd1', name: 'Bay 1', bayTypeCode: 'express', active: true }];
const technicians: Technician[] = [
  { id: 't1', dealershipId: 'd1', name: 'Tech One', active: true, skills: [], shifts: [] },
];

const entries: TechnicianCalendarEntry[] = [
  { appointmentId: 'a2', technicianId: 't1', startAt: '2030-01-07T11:00:00.000Z', endAt: '2030-01-07T12:00:00.000Z', status: 'CONFIRMED', serviceTypeCode: 'oil_change', vehicleVin: 'VIN1', bayName: 'Bay 1' },
  { appointmentId: 'a1', technicianId: 't1', startAt: '2030-01-07T08:00:00.000Z', endAt: '2030-01-07T09:00:00.000Z', status: 'HELD', serviceTypeCode: 'oil_change', vehicleVin: 'VIN1', bayName: 'Bay 1' },
];

const diary: DiaryRepository = {
  technicianAppointments: async () => entries,
  capacityAppointments: async () => [
    { appointmentId: 'a1', bayId: 'b1', technicianId: 't1', startAt: '2030-01-07T08:00:00.000Z', endAt: '2030-01-07T10:00:00.000Z' },
  ],
};

const service = new DiaryServiceImpl({
  diary,
  dealerships: { getById: async () => dealership },
  bays: { listByDealership: async () => bays },
  technicians: { listQualified: async () => technicians },
});
const app = buildApp({ diary: service });

describe('diary views', () => {
  it('technician calendar is chronological and scoped to that technician', async () => {
    const res = await request(app).get('/technicians/t1/appointments').query({ from, to });

    expect(res.status).toBe(200);
    expect(res.body.appointments).toHaveLength(2);
    expect(res.body.appointments.every((a: { technicianId: string }) => a.technicianId === 't1')).toBe(true);

    const starts = res.body.appointments.map((a: { startAt: string }) => Date.parse(a.startAt));
    expect(starts).toEqual([...starts].sort((x, y) => x - y));
    expect(res.body.appointments[0].appointmentId).toBe('a1');
  });

  it('capacity reports utilization as busy minutes / open minutes per bay and technician', async () => {
    const res = await request(app).get('/dealerships/d1/capacity').query({ from, to });

    expect(res.status).toBe(200);
    // 2 open days x 10h = 1200 open minutes; 120 busy minutes -> 10%
    expect(res.body.bays[0]).toMatchObject({ bayId: 'b1', utilizationPct: 10 });
    expect(res.body.technicians[0]).toMatchObject({ technicianId: 't1', utilizationPct: 10 });
    expect(res.body.bays[0].busy).toHaveLength(1);
  });
});
