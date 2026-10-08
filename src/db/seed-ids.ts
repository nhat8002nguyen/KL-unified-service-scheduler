/** Stable ids for the demo seed, shared by seeds and integration tests. */
const id = (n: number): string => `00000000-0000-0000-0000-00000000${String(n).padStart(4, '0')}`;

export const SEED = {
  skills: {
    general: id(1),
    brakes: id(2),
    electrical: id(3),
    diagnostics: id(4),
  },
  bayTypes: {
    express: id(11),
    diagnostic: id(12),
    alignment: id(13),
  },
  serviceTypes: {
    oilChange: id(21),
    brakeJob: id(22),
    diagnostic: id(23),
    majorRepair: id(24),
  },
  dealership: id(100),
  bays: {
    express1: id(201),
    diagnostic1: id(202),
    diagnostic2: id(203),
  },
  technicians: {
    general: id(301),
    master: id(302),
  },
  vehicle: id(400),
  customer: id(500),
} as const;

/** The demo dealership's timezone (the design keeps all instants in UTC). */
export const SEED_TIMEZONE = 'Europe/London';
export const SEED_VIN = '1HGCM82633A004352';
