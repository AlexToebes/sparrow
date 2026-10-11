import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportFileSchema } from '@sparrow/shared';
import { buildApp } from '../src/api/app.js';
import { createDrive } from '../src/core/drives.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';

let opened: OpenedDatabase;
let app: FastifyInstance;
let tmp: string;
let backupDir: string;

beforeEach(async () => {
  opened = openDatabase(':memory:');
  tmp = mkdtempSync(path.join(os.tmpdir(), 'sparrow-backup-api-'));
  backupDir = path.join(tmp, 'exports');
  app = buildApp({ db: opened.db, backupDir });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  opened.sqlite.close();
  rmSync(tmp, { recursive: true, force: true });
});

const exportJson = async () => {
  const res = await app.inject({ method: 'GET', url: '/api/export' });
  return res.json() as unknown;
};

describe('R41, R42: GET /api/export', () => {
  it('returns the export as an attachment named by date', async () => {
    createDrive(opened.db, { serial: 'EXP-1' });
    const res = await app.inject({ method: 'GET', url: '/api/export' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="sparrow-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    const file = exportFileSchema.parse(res.json());
    expect(file.data.drives.map((d) => d.serial)).toEqual(['EXP-1']);
  });
});

describe('R43, R44: POST /api/import', () => {
  it('replaces the data, writes the automatic backup and reports its path and counts', async () => {
    createDrive(opened.db, { serial: 'BEFORE' });
    const incoming = {
      format: 'sparrow-export',
      schemaVersion: 2,
      exportedAt: '2026-10-10T00:00:00.000Z',
      data: {
        enclosures: [],
        grids: [],
        slots: [],
        drives: [],
        pools: [],
        memberships: [],
        events: [],
        appMeta: [],
      },
    };

    const res = await app.inject({ method: 'POST', url: '/api/import', payload: incoming });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { backupPath: string; counts: Record<string, number> };
    expect(body.counts).toMatchObject({ drives: 0, enclosures: 0, events: 0 });
    expect(body.backupPath.startsWith(backupDir)).toBe(true);
    expect(readdirSync(backupDir)).toEqual([path.basename(body.backupPath)]);

    const backup = exportFileSchema.parse(JSON.parse(readFileSync(body.backupPath, 'utf8')));
    expect(backup.data.drives.map((d) => d.serial)).toEqual(['BEFORE']);
    expect(((await exportJson()) as { data: { drives: unknown[] } }).data.drives).toEqual([]);
  });

  it('accepts a large export body (above the 1 MB default limit)', async () => {
    // Notes are capped at 5000 characters, so reach 1 MB+ with many drives.
    for (let i = 0; i < 400; i++) {
      createDrive(opened.db, { serial: `BIG-${i}`, notes: 'x'.repeat(4000) });
    }
    const file = (await exportJson()) as object;
    const res = await app.inject({ method: 'POST', url: '/api/import', payload: file });
    expect(res.statusCode).toBe(200);
  });

  it('returns 400 for an export made by a newer version, and changes nothing', async () => {
    createDrive(opened.db, { serial: 'KEEP' });
    const file = { ...((await exportJson()) as object), schemaVersion: 3 };
    const res = await app.inject({ method: 'POST', url: '/api/import', payload: file });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: {
        code: 'invalid',
        message:
          'This export was made by a newer Sparrow (schema 3); this version supports up to 2.',
      },
    });
    expect(
      ((await exportJson()) as { data: { drives: { serial: string }[] } }).data.drives,
    ).toEqual([expect.objectContaining({ serial: 'KEEP' })]);
    expect(() => readdirSync(backupDir)).toThrow();
  });

  it('returns 400 for a file that is not a Sparrow export', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/import', payload: { hello: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid' } });
  });
});
