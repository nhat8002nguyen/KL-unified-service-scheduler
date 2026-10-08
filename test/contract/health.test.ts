import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildApp } from '../../src/app';

describe('health endpoints', () => {
  it('GET /healthz returns ok', async () => {
    const res = await request(buildApp()).get('/healthz');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});
