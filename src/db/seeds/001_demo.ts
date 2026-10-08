import type { Knex } from 'knex';
import { SEED, SEED_TIMEZONE, SEED_VIN } from '../seed-ids';

const WEEKDAYS_MON_FRI = [1, 2, 3, 4, 5];

/** seed inserts the demo dealership's reference data once, skipping an already-seeded database. */
export async function seed(knex: Knex): Promise<void> {
  // Never wipe an already-seeded database: the container runs this on every boot.
  const existing = await knex('dealership').count<{ count: string }[]>({ count: '*' });
  if (Number(existing[0]?.count ?? 0) > 0) {
    return;
  }

  await knex('skill').insert([
    { id: SEED.skills.general, code: 'general', name: 'General servicing' },
    { id: SEED.skills.brakes, code: 'brakes', name: 'Brakes' },
    { id: SEED.skills.electrical, code: 'electrical', name: 'Electrical' },
    { id: SEED.skills.diagnostics, code: 'diagnostics', name: 'Diagnostics' },
  ]);

  await knex('bay_type').insert([
    { id: SEED.bayTypes.express, code: 'express', name: 'Express / quick-lube' },
    { id: SEED.bayTypes.diagnostic, code: 'diagnostic', name: 'Diagnostic' },
    { id: SEED.bayTypes.alignment, code: 'alignment', name: 'Alignment' },
  ]);

  await knex('service_type').insert([
    { id: SEED.serviceTypes.oilChange, code: 'oil_change', name: 'Oil change', duration_min: 30, buffer_min: 15 },
    { id: SEED.serviceTypes.brakeJob, code: 'brake_job', name: 'Brake job', duration_min: 90, buffer_min: 30 },
    { id: SEED.serviceTypes.diagnostic, code: 'diagnostic', name: 'Diagnostic', duration_min: 120, buffer_min: 30 },
    { id: SEED.serviceTypes.majorRepair, code: 'major_repair', name: 'Major repair', duration_min: 240, buffer_min: 60 },
  ]);

  await knex('service_type_required_skill').insert([
    { service_type_id: SEED.serviceTypes.oilChange, skill_id: SEED.skills.general, min_proficiency: 1 },
    { service_type_id: SEED.serviceTypes.brakeJob, skill_id: SEED.skills.brakes, min_proficiency: 2 },
    { service_type_id: SEED.serviceTypes.diagnostic, skill_id: SEED.skills.diagnostics, min_proficiency: 3 },
    { service_type_id: SEED.serviceTypes.majorRepair, skill_id: SEED.skills.brakes, min_proficiency: 2 },
    { service_type_id: SEED.serviceTypes.majorRepair, skill_id: SEED.skills.electrical, min_proficiency: 2 },
    { service_type_id: SEED.serviceTypes.majorRepair, skill_id: SEED.skills.diagnostics, min_proficiency: 3 },
  ]);

  await knex('service_type_bay_type').insert([
    { service_type_id: SEED.serviceTypes.oilChange, bay_type_id: SEED.bayTypes.express, kind: 'required' },
    { service_type_id: SEED.serviceTypes.brakeJob, bay_type_id: SEED.bayTypes.diagnostic, kind: 'preferred' },
    { service_type_id: SEED.serviceTypes.diagnostic, bay_type_id: SEED.bayTypes.diagnostic, kind: 'required' },
    { service_type_id: SEED.serviceTypes.majorRepair, bay_type_id: SEED.bayTypes.diagnostic, kind: 'required' },
  ]);

  await knex('dealership').insert([
    { id: SEED.dealership, name: 'Keyloop Demo Dealership', timezone: SEED_TIMEZONE },
  ]);
  await knex('dealership_hours').insert([
    ...WEEKDAYS_MON_FRI.map((weekday) => ({
      dealership_id: SEED.dealership,
      weekday,
      open_time: '08:00:00',
      close_time: '18:00:00',
    })),
    { dealership_id: SEED.dealership, weekday: 6, open_time: '09:00:00', close_time: '13:00:00' },
  ]);

  await knex('service_bay').insert([
    { id: SEED.bays.express1, dealership_id: SEED.dealership, name: 'Bay 1 (Express)', bay_type_id: SEED.bayTypes.express, active: true },
    { id: SEED.bays.diagnostic1, dealership_id: SEED.dealership, name: 'Bay 2 (Diagnostic)', bay_type_id: SEED.bayTypes.diagnostic, active: true },
    { id: SEED.bays.diagnostic2, dealership_id: SEED.dealership, name: 'Bay 3 (Diagnostic)', bay_type_id: SEED.bayTypes.diagnostic, active: true },
  ]);

  await knex('technician').insert([
    { id: SEED.technicians.general, dealership_id: SEED.dealership, name: 'General Tech', active: true },
    { id: SEED.technicians.master, dealership_id: SEED.dealership, name: 'Master Tech', active: true },
  ]);

  await knex('technician_skill').insert([
    { technician_id: SEED.technicians.general, skill_id: SEED.skills.general, proficiency: 3 },
    { technician_id: SEED.technicians.general, skill_id: SEED.skills.brakes, proficiency: 3 },
    { technician_id: SEED.technicians.master, skill_id: SEED.skills.general, proficiency: 3 },
    { technician_id: SEED.technicians.master, skill_id: SEED.skills.brakes, proficiency: 4 },
    { technician_id: SEED.technicians.master, skill_id: SEED.skills.electrical, proficiency: 4 },
    { technician_id: SEED.technicians.master, skill_id: SEED.skills.diagnostics, proficiency: 5 },
  ]);

  await knex('technician_shift').insert([
    ...WEEKDAYS_MON_FRI.flatMap((weekday) => [
      { technician_id: SEED.technicians.general, weekday, start_time: '08:00:00', end_time: '17:00:00' },
      { technician_id: SEED.technicians.master, weekday, start_time: '08:00:00', end_time: '17:00:00' },
    ]),
  ]);

  await knex('vehicle').insert([
    { id: SEED.vehicle, vin: SEED_VIN, make: 'Honda', model: 'Civic', year: 2013 },
  ]);

  await knex('customer').insert([
    { id: SEED.customer, name: 'Demo Customer', phone: '+441234567890', email: 'demo.customer@example.com' },
  ]);
}
