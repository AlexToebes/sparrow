import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import type { FastifyInstance } from 'fastify';

let opened: OpenedDatabase;
let app: FastifyInstance;

beforeEach(async () => {
  opened = openDatabase(':memory:');
  app = buildApp({ db: opened.db });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  opened.sqlite.close();
});

const post = (payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/drives', payload: payload as object });
const patch = (id: string, payload: unknown) =>
  app.inject({ method: 'PATCH', url: `/api/drives/${id}`, payload: payload as object });
const get = (url: string) => app.inject({ method: 'GET', url });

describe('drive API (R3, R11, R13, R14, R21, D5, D6)', () => {
  it('R21: POST /api/drives creates a spare from a serial alone and returns 201 with the drive', async () => {
    const res = await post({ serial: ' sp-1 ' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      serial: 'sp-1',
      serialNormalized: 'SP-1',
      status: 'spare',
      slotId: null,
      model: null,
    });
  });

  it('D6: duplicate serial after normalization returns 409 naming the existing drive', async () => {
    const first = (await post({ serial: 'DUP' })).json() as { id: string };
    const res = await post({ serial: ' dup ' });
    expect(res.statusCode).toBe(409);
    const body = res.json() as {
      error: { code: string; message: string; details: { driveId: string } };
    };
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toContain(first.id);
    expect(body.error.details).toEqual({ driveId: first.id });
  });

  it('R13: POST rejects status, slot and retirement fields with 400', async () => {
    for (const extra of [
      { status: 'installed' },
      { slotId: 'x' },
      { retirementReason: 'failed' },
    ]) {
      const res = await post({ serial: 'NS-1', ...extra });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'invalid' } });
    }
    expect((await get('/api/drives')).json()).toEqual([]);
  });

  it('R11: POST rejects a body without serial, and a fractional capacity', async () => {
    expect((await post({ model: 'no serial' })).statusCode).toBe(400);
    expect((await post({ serial: 'C1', capacityBytes: 1.2 })).statusCode).toBe(400);
  });

  it('R14: PATCH edits R11 fields, returns the drive and logs the change', async () => {
    const created = (await post({ serial: 'ED-1' })).json() as { id: string };
    const res = await patch(created.id, { model: 'Exos', capacityBytes: 18_000_000_000_000 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ model: 'Exos', capacityBytes: 18_000_000_000_000 });

    const events = (await get(`/api/drives/${created.id}/events`)).json() as Array<{
      type: string;
      payload: Record<string, unknown>;
    }>;
    expect(events.map((e) => e.type)).toEqual(['drive-updated', 'drive-created']);
    expect(events[0]!.payload).toEqual({
      changes: {
        model: { from: null, to: 'Exos' },
        capacityBytes: { from: null, to: 18_000_000_000_000 },
      },
    });
  });

  it('R13: PATCH rejects status, slot and retirement fields with 400 and changes nothing', async () => {
    const created = (await post({ serial: 'ST-9' })).json() as { id: string };
    for (const extra of [
      { status: 'retired' },
      { slotId: 'x' },
      { retirementDate: '2026-01-01' },
    ]) {
      const res = await patch(created.id, extra);
      expect(res.statusCode).toBe(400);
    }
    expect((await get(`/api/drives/${created.id}`)).json()).toMatchObject({ status: 'spare' });
    expect((await get(`/api/drives/${created.id}/events`)).json()).toHaveLength(1);
  });

  it("D6: PATCH to another drive's serial returns 409 and leaves both drives alone", async () => {
    await post({ serial: 'TAKEN' });
    const other = (await post({ serial: 'FREE' })).json() as { id: string };
    const res = await patch(other.id, { serial: 'taken' });
    expect(res.statusCode).toBe(409);
    expect((await get(`/api/drives/${other.id}`)).json()).toMatchObject({ serial: 'FREE' });
  });

  it('PATCH and GET of an unknown drive return 404', async () => {
    expect((await patch('missing', { model: 'x' })).statusCode).toBe(404);
    expect((await get('/api/drives/missing')).statusCode).toBe(404);
    expect((await get('/api/drives/missing/events')).statusCode).toBe(404);
  });

  it('R3: GET /api/drives filters by status; an unknown status is 400', async () => {
    await post({ serial: 'F-1' });
    await post({ serial: 'F-2' });
    const all = (await get('/api/drives')).json() as unknown[];
    expect(all).toHaveLength(2);
    expect((await get('/api/drives?status=spare')).json()).toHaveLength(2);
    expect((await get('/api/drives?status=installed')).json()).toEqual([]);
    expect((await get('/api/drives?status=bogus')).statusCode).toBe(400);
  });

  it('R14: GET /api/drives/:id/events returns events newest first', async () => {
    const created = (await post({ serial: 'NF-1' })).json() as { id: string };
    await patch(created.id, { vendor: 'A' });
    await patch(created.id, { vendor: 'B' });
    const events = (await get(`/api/drives/${created.id}/events`)).json() as Array<{
      type: string;
    }>;
    expect(events.map((e) => e.type)).toEqual(['drive-updated', 'drive-updated', 'drive-created']);
  });

  it('D5: DELETE /api/drives/:id is not routed (404 or 405) and the drive still exists', async () => {
    const created = (await post({ serial: 'NODEL' })).json() as { id: string };
    const res = await app.inject({ method: 'DELETE', url: `/api/drives/${created.id}` });
    expect([404, 405]).toContain(res.statusCode);
    const after = await get(`/api/drives/${created.id}`);
    expect(after.statusCode).toBe(200);
    expect(after.json()).toMatchObject({ serial: 'NODEL' });
  });
});
