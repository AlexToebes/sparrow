import { z } from 'zod';
import { timestampSchema } from './common.js';
import { driveTypeSchema, healthSchema, observationStateSchema } from './enums.js';

/** R49, Appendix A. Serial is optional: missing means "unidentified" (R58). */
export const observationSchema = z.object({
  serial: z.string().optional(),
  wwn: z.string().optional(),
  model: z.string().optional(),
  capacityBytes: z.number().int().min(0).optional(),
  driveType: driveTypeSchema.optional(),
  formFactor: z.string().optional(),
  health: healthSchema,
  lastReportedAt: timestampSchema,
  state: observationStateSchema,
  temperatureC: z.number().optional(),
  detailUrl: z.url().optional(),
});
export type Observation = z.infer<typeof observationSchema>;
