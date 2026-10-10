import { z } from 'zod';

export const idSchema = z.string().min(1);
/** D3: UTC ISO-8601 timestamp with Z. */
export const timestampSchema = z.iso.datetime();
/** Calendar date, YYYY-MM-DD. */
export const dateSchema = z.iso.date();
