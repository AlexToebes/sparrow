// R14, R33, N1: the API error shape, domain error mapping and cross-site hardening.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../src/api/app.js';
import { conflict, DomainError, invalid, notFound } from '../src/core/errors.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';

let opened: OpenedDatabase;
beforeEach(() => {
  opened = openDatabase(':memory:');
});
afterEach(() => opened.sqlite.close());

describe('error helpers', () => {
  it('build DomainError with the matching code, message and optional details', () => {
    const nf = notFound('no drive');
    expect(nf).toBeInstanceOf(DomainError);
    expect(nf).toBeInstanceOf(Error);
    expect(nf.code).toBe('not-found');
    expect(nf.message).toBe('no drive');
    expect(nf.details).toBeUndefined();

    const cf = conflict('slot taken', { slotId: 's1' });
    expect(cf.code).toBe('conflict');
    expect(cf.details).toEqual({ slotId: 's1' });

    expect(invalid('bad').code).toBe('invalid');
  });
});

describe('API error mapping', () => {
  it('maps DomainError codes, ZodError, Fastify client errors and unknown errors', async () => {
    const app = buildApp({ db: opened.db });
    app.get('/test/throw/:kind', async (req) => {
      const kind = (req.params as { kind: string }).kind;
      switch (kind) {
        case 'not-found':
          throw notFound('missing thing');
        case 'conflict':
          throw conflict('occupied', { slotId: 's1' });
        case 'invalid':
          throw invalid('bad input');
        case 'zod':
          z.object({ n: z.number() }).parse({ n: 'x' });
          return {};
        case 'boom':
          throw new Error('secret internals');
        default:
          return {};
      }
    });
    app.post('/test/body', async () => ({ ok: true }));

    const get = (kind: string) => app.inject({ method: 'GET', url: `/test/throw/${kind}` });

    const nf = await get('not-found');
    expect(nf.statusCode).toBe(404);
    expect(nf.json()).toEqual({ error: { code: 'not-found', message: 'missing thing' } });

    const cf = await get('conflict');
    expect(cf.statusCode).toBe(409);
    expect(cf.json()).toEqual({
      error: { code: 'conflict', message: 'occupied', details: { slotId: 's1' } },
    });

    const inv = await get('invalid');
    expect(inv.statusCode).toBe(400);
    expect(inv.json()).toEqual({ error: { code: 'invalid', message: 'bad input' } });

    const zod = await get('zod');
    expect(zod.statusCode).toBe(400);
    const zodBody = zod.json() as { error: { code: string; details: unknown[] } };
    expect(zodBody.error.code).toBe('invalid');
    expect(zodBody.error.details).toEqual(expect.any(Array));

    const boom = await get('boom');
    expect(boom.statusCode).toBe(500);
    expect(boom.json()).toEqual({ error: { code: 'internal', message: 'Internal server error' } });
    expect(boom.body).not.toContain('secret internals');

    const malformed = await app.inject({
      method: 'POST',
      url: '/test/body',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ error: { code: 'invalid' } });

    await app.close();
  });

  it('answers unknown routes with a 404 in the error shape', async () => {
    const app = buildApp({ db: opened.db });
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'not-found', message: 'Route GET /api/nope not found' },
    });
    await app.close();
  });

  it('treats an empty JSON body as {} and still rejects malformed JSON with a 400', async () => {
    const app = buildApp({ db: opened.db });
    app.post('/test/echo', async (req) => ({ body: req.body }));
    const empty = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'content-type': 'application/json' },
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ body: {} });
    const ok = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":1}',
    });
    expect(ok.json()).toEqual({ body: { a: 1 } });
    const bad = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: { code: 'invalid' } });
    await app.close();
  });
});

describe('N1 hardening (no authentication, so close the cross-site doors)', () => {
  it('N1: non-GET /api writes need content-type application/json (415 otherwise)', async () => {
    const app = buildApp({ db: opened.db });
    app.post('/api/test/write', async () => ({ ok: true }));
    app.delete('/api/test/write', async () => ({ ok: true }));
    for (const method of ['POST', 'DELETE'] as const) {
      const bare = await app.inject({ method, url: '/api/test/write' });
      expect(bare.statusCode).toBe(415);
      expect(bare.json()).toMatchObject({ error: { code: 'unsupported-media-type' } });
      const text = await app.inject({
        method,
        url: '/api/test/write',
        headers: { 'content-type': 'text/plain' },
        payload: '{}',
      });
      expect(text.statusCode).toBe(415);
      const json = await app.inject({
        method,
        url: '/api/test/write',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        payload: '{}',
      });
      expect(json.statusCode).toBe(200);
    }
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    await app.close();
  });

  it('N1: a real write route refuses a bodyless POST and leaves the data alone', async () => {
    const app = buildApp({ db: opened.db });
    const res = await app.inject({ method: 'POST', url: '/api/drives/nope/reinstate' });
    expect(res.statusCode).toBe(415);
    await app.close();
  });

  it('N1: every response forbids framing and content sniffing', async () => {
    const app = buildApp({ db: opened.db });
    for (const url of ['/api/health', '/api/nope']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    }
    await app.close();
  });

  it('N1: ALLOWED_HOSTS rejects other Host names (DNS rebinding) but keeps /api/health open', async () => {
    const app = buildApp({ db: opened.db, allowedHosts: ['sparrow.lan', 'localhost:3000'] });
    const get = (host: string, url = '/api/layout') =>
      app.inject({ method: 'GET', url, headers: { host } });
    expect((await get('sparrow.lan:3000')).statusCode).not.toBe(403);
    expect((await get('SPARROW.LAN')).statusCode).not.toBe(403);
    expect((await get('localhost:3000')).statusCode).not.toBe(403);
    const evil = await get('evil.example:3000');
    expect(evil.statusCode).toBe(403);
    expect(evil.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect((await get('evil.example', '/api/health')).statusCode).toBe(200);
    await app.close();
  });

  it('N1: with no allowlist any Host is accepted', async () => {
    const app = buildApp({ db: opened.db });
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'x.test' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
