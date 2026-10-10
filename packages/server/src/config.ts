import { z } from 'zod';

const configSchema = z.object({
  DATA_DIR: z.string().min(1).default('/data'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  PROVIDER: z.string().min(1).default('none'),
  POLL_INTERVAL_MINUTES: z.coerce.number().positive().default(5),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return configSchema.parse(env);
}
