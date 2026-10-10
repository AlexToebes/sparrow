import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { openDatabase } from '../src/db/client.js';

describe('GET /api/config (R41, R44 settings view)', () => {
  it('returns effective config without secrets', async () => {
    const { db, sqlite } = openDatabase(':memory:');
    const app = buildApp({
      db,
      staleAfterHours: 3,
      pollIntervalMinutes: 7,
      dataDir: '/data',
      backupDir: '/data/exports',
    });
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      provider: 'none',
      pollIntervalMinutes: 7,
      staleAfterHours: 3,
      dataDir: '/data',
      backupDir: '/data/exports',
    });
    await app.close();
    sqlite.close();
  });
});
