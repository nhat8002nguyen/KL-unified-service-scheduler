import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PgResourcesRepo } from '../../src/resources/resources.repo';
import { PgCatalogRepo } from '../../src/catalog/catalog.repo';
import { SEED, SEED_VIN } from '../../src/db/seed-ids';

const url = process.env['DATABASE_URL'];
const maybe = url ? describe : describe.skip;

maybe('reference-data readers', () => {
  let pool: Pool;
  let resources: PgResourcesRepo;
  let catalog: PgCatalogRepo;

  beforeAll(() => {
    pool = new Pool({ connectionString: url });
    resources = new PgResourcesRepo(pool);
    catalog = new PgCatalogRepo(pool);
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('listQualified returns only technicians covering every required skill at min proficiency', async () => {
    const techs = await resources.listQualified(SEED.dealership, [
      { skillCode: 'diagnostics', minProficiency: 3 },
    ]);

    expect(techs.map((t) => t.name)).toEqual(['Master Tech']);
    expect(techs[0]?.skills).toContainEqual({ skillCode: 'diagnostics', proficiency: 5 });
  });

  it('getServiceTypeDetail resolves duration, buffer, required skills, and bay types', async () => {
    const st = await catalog.getServiceTypeDetail('diagnostic');

    expect(st).not.toBeNull();
    expect(st?.durationMin).toBe(120);
    expect(st?.bufferMin).toBe(30);
    expect(st?.requiredSkills).toEqual([{ skillCode: 'diagnostics', minProficiency: 3 }]);
    expect(st?.bayTypes).toEqual([{ bayTypeCode: 'diagnostic', kind: 'required' }]);
  });

  it('getById returns dealership hours as local HH:MM and listByDealership maps bay types', async () => {
    const dealership = await resources.getById(SEED.dealership);
    expect(dealership?.timezone).toBe('Europe/London');
    expect(dealership?.hours.find((h) => h.weekday === 1)).toEqual({
      weekday: 1,
      open: '08:00',
      close: '18:00',
    });

    const bays = await resources.listByDealership(SEED.dealership);
    expect(bays.map((b) => b.bayTypeCode).sort()).toEqual(['diagnostic', 'diagnostic', 'express']);
  });

  it('getByVin finds the seeded vehicle', async () => {
    const vehicle = await resources.getByVin(SEED_VIN);

    expect(vehicle?.make).toBe('Honda');
    expect(vehicle?.year).toBe(2013);
  });
});
