// R10, N1: the API client.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, apiGet, apiSend } from '../src/api/client';

afterEach(() => vi.restoreAllMocks());

const reply = (status: number, body: unknown) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe('api client', () => {
  it('parses a good response with the schema', async () => {
    reply(200, { n: 1 });
    await expect(apiGet('/x', z.object({ n: z.number() }))).resolves.toEqual({ n: 1 });
  });

  it('turns the server error body into a typed ApiError', async () => {
    reply(409, { error: { code: 'conflict', message: 'Slot is occupied', details: { a: 1 } } });
    const err = await apiGet('/x', z.unknown()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 409,
      code: 'conflict',
      message: 'Slot is occupied',
      details: { a: 1 },
    });
  });

  it('rejects a response that does not match the schema', async () => {
    reply(200, { n: 'nope' });
    await expect(apiGet('/x', z.object({ n: z.number() }))).rejects.toMatchObject({
      code: 'bad-response',
    });
  });

  it('N1: every write sends a JSON content type, with {} when there is no body', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('{}', { status: 200 }));
    await apiSend('POST', '/x', undefined, z.unknown());
    await apiSend('DELETE', '/x', undefined, z.unknown());
    await apiSend('PATCH', '/x', { a: 1 }, z.unknown());
    const inits = spy.mock.calls.map(([, init]) => init as RequestInit);
    for (const init of inits) expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(inits.map((i) => i.body)).toEqual(['{}', '{}', '{"a":1}']);
  });

  it('reports a network failure as ApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('boom'));
    await expect(apiGet('/x', z.unknown())).rejects.toMatchObject({ code: 'network', status: 0 });
  });
});
