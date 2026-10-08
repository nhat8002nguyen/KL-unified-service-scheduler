export interface Vehicle {
  id: string;
  vin: string;
  make: string;
  model: string;
  year: number;
}

export interface VehicleReader {
  getByVin(vin: string): Promise<Vehicle | null>;
}

/** Opening hours in the dealership's local wall clock ('HH:MM'); instants stay UTC. */
export interface OpeningHours {
  weekday: number;
  open: string;
  close: string;
}

export interface Dealership {
  id: string;
  name: string;
  timezone: string;
  hours: OpeningHours[];
}

export interface DealershipReader {
  getById(id: string): Promise<Dealership | null>;
}

export interface ServiceBay {
  id: string;
  dealershipId: string;
  name: string;
  bayTypeCode: string;
  active: boolean;
}

export interface BayReader {
  listByDealership(dealershipId: string): Promise<ServiceBay[]>;
}

export interface TechnicianSkill {
  skillCode: string;
  proficiency: number;
}

/** A recurring working window in local wall clock ('HH:MM'). */
export interface Shift {
  weekday: number;
  start: string;
  end: string;
}

export interface Technician {
  id: string;
  dealershipId: string;
  name: string;
  active: boolean;
  skills: TechnicianSkill[];
  shifts: Shift[];
}

export interface RequiredSkill {
  skillCode: string;
  minProficiency: number;
}

export interface TechnicianReader {
  /** Technicians at the dealership whose skills cover every required skill at the minimum level. */
  listQualified(dealershipId: string, required: readonly RequiredSkill[]): Promise<Technician[]>;
}
