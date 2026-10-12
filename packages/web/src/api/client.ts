import { z } from 'zod';

/** The server's error body: `{ error: { code, message, details? } }`. */
const errorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Fetches JSON from the API and validates it with a zod schema. Throws ApiError on any failure. */
export async function apiGet<S extends z.ZodType>(path: string, schema: S): Promise<z.output<S>> {
  return request(path, { method: 'GET' }, schema);
}

export async function apiSend<S extends z.ZodType>(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  schema: S,
): Promise<z.output<S>> {
  return request(
    path,
    {
      method,
      // N1: the server only accepts JSON writes, so even a bodyless action sends {}.
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    },
    schema,
  );
}

async function request<S extends z.ZodType>(
  path: string,
  init: RequestInit,
  schema: S,
): Promise<z.output<S>> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the Sparrow server');
  }
  const text = await res.text();
  let json: unknown = undefined;
  if (text !== '') {
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError(res.status, 'bad-response', 'The server sent a response that is not JSON');
    }
  }
  if (!res.ok) {
    const parsed = errorBodySchema.safeParse(json);
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      throw new ApiError(res.status, code, message, details);
    }
    throw new ApiError(res.status, 'http', `Request failed (${res.status})`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError(
      res.status,
      'bad-response',
      'The server response did not match the expected shape',
      parsed.error.issues,
    );
  }
  return parsed.data;
}
