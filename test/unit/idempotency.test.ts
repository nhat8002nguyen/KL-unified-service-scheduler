import { describe, it, expect } from 'vitest';
import { fingerprintReserveRequest } from '../../src/booking/idempotency';

describe('fingerprintReserveRequest', () => {
  const base = {
    dealershipId: 'd1',
    serviceTypeId: 's1',
    vehicleId: 'v1',
    bayId: 'b1',
    technicianId: 't1',
    startAt: '2030-01-07T08:00:00.000Z',
    endAt: '2030-01-07T09:00:00.000Z',
  };

  it('is stable for the same booking fields', () => {
    expect(fingerprintReserveRequest(base)).toBe(fingerprintReserveRequest({ ...base }));
  });

  it('changes when the slot identity changes', () => {
    expect(fingerprintReserveRequest(base)).not.toBe(
      fingerprintReserveRequest({ ...base, bayId: 'b2' }),
    );
  });
});
