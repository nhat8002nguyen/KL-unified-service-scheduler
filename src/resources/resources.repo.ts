import { clockHhMm } from '../common/time';
import type { Db } from '../db/pool';
import type {
  BayReader,
  Dealership,
  DealershipReader,
  RequiredSkill,
  ServiceBay,
  Shift,
  Technician,
  TechnicianReader,
  TechnicianSkill,
  Vehicle,
  VehicleReader,
} from './resources.types';

interface TechnicianRow {
  id: string;
  dealership_id: string;
  name: string;
  active: boolean;
  skill_code: string | null;
  proficiency: number | null;
}

/**
 * Reference-data readers over a single Postgres. The interface split
 * (VehicleReader / DealershipReader / BayReader / TechnicianReader) is the
 * future microservice seam: each can be swapped for an HTTP client.
 */
export class PgResourcesRepo
  implements VehicleReader, DealershipReader, BayReader, TechnicianReader
{
  constructor(private readonly db: Db) {}

  async getByVin(vin: string): Promise<Vehicle | null> {
    const { rows } = await this.db.query<Vehicle>(
      'select id, vin, make, model, year from vehicle where vin = $1',
      [vin],
    );
    return rows[0] ?? null;
  }

  async getById(id: string): Promise<Dealership | null> {
    const { rows } = await this.db.query<{ id: string; name: string; timezone: string }>(
      'select id, name, timezone from dealership where id = $1',
      [id],
    );
    const row = rows[0];
    if (!row) return null;

    const hours = await this.db.query<{ weekday: number; open_time: string; close_time: string }>(
      'select weekday, open_time, close_time from dealership_hours where dealership_id = $1 order by weekday',
      [id],
    );

    return {
      id: row.id,
      name: row.name,
      timezone: row.timezone,
      hours: hours.rows.map((h) => ({
        weekday: h.weekday,
        open: clockHhMm(h.open_time),
        close: clockHhMm(h.close_time),
      })),
    };
  }

  async listByDealership(dealershipId: string): Promise<ServiceBay[]> {
    const { rows } = await this.db.query<{
      id: string;
      dealership_id: string;
      name: string;
      bay_type_code: string;
      active: boolean;
    }>(
      `select b.id, b.dealership_id, b.name, bt.code as bay_type_code, b.active
         from service_bay b
         join bay_type bt on bt.id = b.bay_type_id
        where b.dealership_id = $1
        order by b.name`,
      [dealershipId],
    );
    return rows.map((r) => ({
      id: r.id,
      dealershipId: r.dealership_id,
      name: r.name,
      bayTypeCode: r.bay_type_code,
      active: r.active,
    }));
  }

  async listQualified(
    dealershipId: string,
    required: readonly RequiredSkill[],
  ): Promise<Technician[]> {
    const { rows } = await this.db.query<TechnicianRow>(
      `select t.id, t.dealership_id, t.name, t.active, s.code as skill_code, ts.proficiency
         from technician t
         left join technician_skill ts on ts.technician_id = t.id
         left join skill s on s.id = ts.skill_id
        where t.dealership_id = $1 and t.active
        order by t.name`,
      [dealershipId],
    );

    const byId = new Map<string, Technician>();
    for (const r of rows) {
      let tech = byId.get(r.id);
      if (!tech) {
        tech = {
          id: r.id,
          dealershipId: r.dealership_id,
          name: r.name,
          active: r.active,
          skills: [],
          shifts: [],
        };
        byId.set(r.id, tech);
      }
      if (r.skill_code && r.proficiency !== null) {
        tech.skills.push({ skillCode: r.skill_code, proficiency: r.proficiency });
      }
    }
    if (byId.size === 0) return [];

    const ids = [...byId.keys()];
    const { rows: shiftRows } = await this.db.query<{
      technician_id: string;
      weekday: number;
      start_time: string;
      end_time: string;
    }>(
      `select technician_id, weekday, start_time, end_time
         from technician_shift
        where technician_id = any($1::uuid[])
        order by technician_id, weekday`,
      [ids],
    );
    for (const s of shiftRows) {
      const shift: Shift = {
        weekday: s.weekday,
        start: clockHhMm(s.start_time),
        end: clockHhMm(s.end_time),
      };
      byId.get(s.technician_id)?.shifts.push(shift);
    }

    return [...byId.values()].filter((tech) => covers(tech.skills, required));
  }
}

function covers(skills: TechnicianSkill[], required: readonly RequiredSkill[]): boolean {
  return required.every((req) =>
    skills.some((s) => s.skillCode === req.skillCode && s.proficiency >= req.minProficiency),
  );
}
