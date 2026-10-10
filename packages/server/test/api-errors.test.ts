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
});
