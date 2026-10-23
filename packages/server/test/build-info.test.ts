import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from '@sparrow/shared';
import { buildApp } from '../src/api/app.js';
import { loadBuildInfo } from '../src/build-info.js';
import { openDatabase } from '../src/db/client.js';

const pkgVersion = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

describe('build info (versioning, R67)', () => {
  it('reads the version from package.json and the commit from GIT_COMMIT', () => {
    expect(loadBuildInfo({ GIT_COMMIT: '4f9feb7a1b2c' })).toEqual({
      version: pkgVersion,
      commit: '4f9feb7a1b2c',
    });
  });

  it('defaults the commit to "unknown" when GIT_COMMIT is unset or blank', () => {
    expect(loadBuildInfo({}).commit).toBe('unknown');
    expect(loadBuildInfo({ GIT_COMMIT: ' ' }).commit).toBe('unknown');
  });

  it('GET /api/health reports status, version and commit', async () => {
    const { db, sqlite } = openDatabase(':memory:');
    const app = buildApp({ db, buildInfo: loadBuildInfo({ GIT_COMMIT: 'abc1234' }) });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(healthResponseSchema.parse(res.json())).toEqual({
      status: 'ok',
      version: pkgVersion,
      commit: 'abc1234',
    });
    await app.close();
    sqlite.close();
  });

  it('GET /api/health without build info shows the package version and commit "unknown"', async () => {
    const { db, sqlite } = openDatabase(':memory:');
    const app = buildApp({ db });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json()).toEqual({ status: 'ok', version: pkgVersion, commit: 'unknown' });
    await app.close();
    sqlite.close();
  });
});
