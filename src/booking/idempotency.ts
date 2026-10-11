import { createHash } from 'node:crypto';

export interface ReserveFingerprintInput {
  dealershipId: string;
  serviceTypeId: string;
  vehicleId: string;
  bayId: string;
  technicianId: string;
  startAt: string;
  endAt: string;
}

/** fingerprintReserveRequest hashes the booking-identity fields for idempotency mismatch detection. */
export function fingerprintReserveRequest(input: ReserveFingerprintInput): string {
  const canonical = [
    input.dealershipId,
    input.serviceTypeId,
    input.vehicleId,
    input.bayId,
    input.technicianId,
    input.startAt,
    input.endAt,
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}
