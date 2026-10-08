import type { Db } from '../db/pool';
import type { BayTypeKind, CatalogRepository, ServiceTypeDetail } from './catalog.types';

interface ServiceTypeRow {
  id: string;
  code: string;
  name: string;
  duration_min: number;
  buffer_min: number;
}

export class PgCatalogRepo implements CatalogRepository {
  /** constructor stores the database pool for catalog queries. */
  constructor(private readonly db: Db) {}

  /** getServiceTypeDetail loads a service type by code, or null if absent. */
  async getServiceTypeDetail(code: string): Promise<ServiceTypeDetail | null> {
    const { rows } = await this.db.query<ServiceTypeRow>(
      'select id, code, name, duration_min, buffer_min from service_type where code = $1',
      [code],
    );
    const row = rows[0];
    return row ? this.hydrate(row) : null;
  }

  /** listServiceTypes returns all service types ordered by code. */
  async listServiceTypes(): Promise<ServiceTypeDetail[]> {
    const { rows } = await this.db.query<ServiceTypeRow>(
      'select id, code, name, duration_min, buffer_min from service_type order by code',
    );
    return Promise.all(rows.map((row) => this.hydrate(row)));
  }

  /** hydrate expands a service-type row with its required skills and bay types. */
  private async hydrate(row: ServiceTypeRow): Promise<ServiceTypeDetail> {
    const [skills, bays] = await Promise.all([
      this.db.query<{ skill_code: string; min_proficiency: number }>(
        `select s.code as skill_code, sts.min_proficiency
           from service_type_required_skill sts
           join skill s on s.id = sts.skill_id
          where sts.service_type_id = $1
          order by s.code`,
        [row.id],
      ),
      this.db.query<{ bay_type_code: string; kind: BayTypeKind }>(
        `select bt.code as bay_type_code, stb.kind
           from service_type_bay_type stb
           join bay_type bt on bt.id = stb.bay_type_id
          where stb.service_type_id = $1
          order by bt.code`,
        [row.id],
      ),
    ]);

    return {
      id: row.id,
      code: row.code,
      name: row.name,
      durationMin: row.duration_min,
      bufferMin: row.buffer_min,
      requiredSkills: skills.rows.map((s) => ({
        skillCode: s.skill_code,
        minProficiency: s.min_proficiency,
      })),
      bayTypes: bays.rows.map((b) => ({ bayTypeCode: b.bay_type_code, kind: b.kind })),
    };
  }
}
