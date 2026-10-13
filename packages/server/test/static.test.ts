import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { isClientRoute } from '../src/api/static.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';

let opened: OpenedDatabase;
let dist: string;
beforeEach(() => {
  opened = openDatabase(':memory:');
  dist = mkdtempSync(path.join(tmpdir(), 'sparrow-web-'));
  mkdirSync(path.join(dist, 'assets'));
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Sparrow</title>');
  writeFileSync(path.join(dist, 'assets', 'x.js'), 'console.log(1);');
});
afterEach(() => {
  opened.sqlite.close();
  rmSync(dist, { recursive: true, force: true });
});

describe('R16: serving the web bundle', () => {
  it('serves index.html at / and for client routes, files from /assets, and keeps /api intact', async () => {
    const app = buildApp({ db: opened.db, webDistDir: dist });
    const root = await app.inject('/');
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('<title>Sparrow</title>');

    const route = await app.inject('/drives/abc');
    expect(route.statusCode).toBe(200);
    expect(route.headers['content-type']).toContain('text/html');
    expect(route.body).toContain('<title>Sparrow</title>');

    const asset = await app.inject('/assets/x.js');
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe('console.log(1);');
    expect(asset.headers['cache-control']).toContain('immutable');

    const missingAsset = await app.inject('/assets/missing.js');
    expect(missingAsset.statusCode).toBe(404);
    expect(missingAsset.json().error.code).toBe('not-found');

    const unknownApi = await app.inject('/api/nope');
    expect(unknownApi.statusCode).toBe(404);
    expect(unknownApi.json().error.code).toBe('not-found');

    const postApi = await app.inject({ method: 'POST', url: '/api/nope', payload: {} });
    expect(postApi.statusCode).toBe(404);
    expect(postApi.json().error.code).toBe('not-found');

    const health = await app.inject('/api/health');
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('serves the manifest and icons as files with the right content types, not index.html', async () => {
    writeFileSync(path.join(dist, 'manifest.webmanifest'), '{"name":"Sparrow"}');
    writeFileSync(path.join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(path.join(dist, 'icon-192.png'), 'png');
    const app = buildApp({ db: opened.db, webDistDir: dist });
    const manifest = await app.inject('/manifest.webmanifest');
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers['content-type']).toContain('application/manifest+json');
    expect(manifest.json()).toEqual({ name: 'Sparrow' });
    const svg = await app.inject('/favicon.svg');
    expect(svg.statusCode).toBe(200);
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    const png = await app.inject('/icon-192.png');
    expect(png.statusCode).toBe(200);
    expect(png.headers['content-type']).toContain('image/png');
    expect((await app.inject('/icon-999.png')).statusCode).toBe(404);
    expect((await app.inject('/favicon.ico')).statusCode).toBe(404);
    await app.close();
  });

  it('R67: the API still works when the bundle is missing', async () => {
    const app = buildApp({ db: opened.db, webDistDir: path.join(dist, 'nope') });
    expect((await app.inject('/api/health')).statusCode).toBe(200);
    const res = await app.inject('/');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not-found');
    await app.close();
  });

  it('isClientRoute excludes /api, files and non-GET methods', () => {
    expect(isClientRoute('GET', '/drives')).toBe(true);
    expect(isClientRoute('GET', '/settings?x=1')).toBe(true);
    expect(isClientRoute('GET', '/api')).toBe(false);
    expect(isClientRoute('GET', '/api/x')).toBe(false);
    expect(isClientRoute('GET', '/apiary')).toBe(true);
    expect(isClientRoute('GET', '/a/b.css')).toBe(false);
    expect(isClientRoute('POST', '/drives')).toBe(false);
  });
});
