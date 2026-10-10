import { z } from 'zod';

/** R45: adapter settings are owned and parsed by the adapter, not by core config. */
const scrutinyConfigSchema = z.object({
  SCRUTINY_URL: z.url({ error: 'SCRUTINY_URL is required and must be a URL (e.g. http://scrutiny:8080)' }),
  SCRUTINY_TOKEN: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined)),
});

export interface ScrutinyConfig {
  /** Base URL without a trailing slash. */
  baseUrl: string;
  token?: string;
}

export function loadScrutinyConfig(env: Record<string, string | undefined>): ScrutinyConfig {
  const parsed = scrutinyConfigSchema.safeParse({
    SCRUTINY_URL: env.SCRUTINY_URL?.trim(),
    SCRUTINY_TOKEN: env.SCRUTINY_TOKEN,
  });
  if (!parsed.success) {
    throw new Error(`Invalid Scrutiny configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const { SCRUTINY_URL, SCRUTINY_TOKEN } = parsed.data;
  return {
    baseUrl: SCRUTINY_URL.replace(/\/+$/, ''),
    ...(SCRUTINY_TOKEN ? { token: SCRUTINY_TOKEN } : {}),
  };
}
