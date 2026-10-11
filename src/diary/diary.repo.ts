import type { AppointmentStatus } from '../domain/types';
import type { Db } from '../db/pool';
import type { CapacityAppointment, DiaryRepository, TechnicianCalendarEntry } from './diary.types';

/** Read-only views over the diary; the only writer is the booking service. */
export class PgDiaryRepo implements DiaryRepository {
  /** constructor stores the database handle used for diary reads. */
  constructor(private readonly db: Db) {}

  /** technicianAppointments lists a technician's non-cancelled appointments overlapping the window. */
  async technicianAppointments(
    technicianId: string,
    from: string,
    to: string,
  ): Promise<TechnicianCalendarEntry[]> {
    const { rows } = await this.db.query<{
      id: string;
      technician_id: string;
      start_at: Date;
      end_at: Date;
      status: AppointmentStatus;
      service_type_code: string;
      vin: string;
      bay_name: string;
    }>(
      `select a.id, a.technician_id, a.start_at, a.end_at, a.status,
              st.code as service_type_code, v.vin, b.name as bay_name
         from appointment a
         join service_type st on st.id = a.service_type_id
         join vehicle v on v.id = a.vehicle_id
         join service_bay b on b.id = a.service_bay_id
        where a.technician_id = $1
          and a.status not in ('CANCELLED','NO_SHOW')
          and tstzrange(a.start_at, a.end_at) && tstzrange($2::timestamptz, $3::timestamptz)
        order by a.start_at`,
      [technicianId, from, to],
    );

    return rows.map((r) => ({
      appointmentId: r.id,
      technicianId: r.technician_id,
      startAt: r.start_at.toISOString(),
      endAt: r.end_at.toISOString(),
      status: r.status,
      serviceTypeCode: r.service_type_code,
      vehicleVin: r.vin,
      bayName: r.bay_name,
    }));
  }

  /** capacityAppointments lists a dealership's non-cancelled appointments overlapping the window. */
  async capacityAppointments(
    dealershipId: string,
    from: string,
    to: string,
  ): Promise<CapacityAppointment[]> {
    const { rows } = await this.db.query<{
      id: string;
      service_bay_id: string;
      technician_id: string;
      start_at: Date;
      end_at: Date;
    }>(
      `select id, service_bay_id, technician_id, start_at, end_at
         from appointment
        where dealership_id = $1
          and status not in ('CANCELLED','NO_SHOW')
          and tstzrange(start_at, end_at) && tstzrange($2::timestamptz, $3::timestamptz)`,
      [dealershipId, from, to],
    );

    return rows.map((r) => ({
      appointmentId: r.id,
      bayId: r.service_bay_id,
      technicianId: r.technician_id,
      startAt: r.start_at.toISOString(),
      endAt: r.end_at.toISOString(),
    }));
  }
}
