import type { DriveType, Health, Observation } from '@sparrow/shared';
import { z } from 'zod';

/**
 * Raw Scrutiny `/api/summary` response (R46). Everything is optional/defaulted because the real
 * capture shows variability: the nvme0 record has no `smart` block, empty strings for serial/WWN/
 * form factor, and archived devices carry old collector dates. Unknown keys are ignored.
 */
const rawEntrySchema = z.object({
  device: z.object({
    device_id: z.string().default(''),
    wwn: z.string().default(''),
    serial_number: z.string().default(''),
    model_name: z.string().default(''),
    form_factor: z.string().default(''),
    device_protocol: z.string().default(''),
    device_type: z.string().default(''),
    capacity: z.number().default(0),
    /** No default: a missing speed is unknown, not 0 (which would read as SSD). */
    rotational_speed: z.number().optional(),
    archived: z.boolean().default(false),
    device_status: z.number().int().default(0),
    UpdatedAt: z.string().optional(),
  }),
  smart: z
    .object({
      collector_date: z.string().optional(),
      risk_category: z.string().optional(),
      temp: z.number().optional(),
    })
    .nullish(),
});
export type RawEntry = z.infer<typeof rawEntrySchema>;

export const rawSummarySchema = z.object({
  success: z.boolean().optional(),
  data: z.object({ summary: z.record(z.string(), z.unknown()) }),
});

/** device_status bit flags (verified against Scrutiny source, see IMPLEMENTATION_PLAN Step 5 notes). */
const STATUS_SMART_FAILED = 1;
const STATUS_SCRUTINY_FAILED = 2;

/** Used when a record never reported (no collector date and no UpdatedAt): reads as maximally stale. */
const NEVER_REPORTED = '1970-01-01T00:00:00.000Z';

/**
 * Appendix B. `risk_category` values seen in the real capture are `healthy`, `monitor`,
 * `plan_replacement` and `replace_soon`. Appendix B names only the last two plus `monitor`
 * (ok); `healthy` is not listed there and also maps to ok, as does any unrecognised value
 * (only the explicit failure flags and categories raise a drive above ok).
 * `hasSmart` false means no SMART data was collected. */
export function mapHealth(
  status: number,
  riskCategory: string | undefined,
  hasSmart: boolean,
): Health {
  if ((status & STATUS_SMART_FAILED) !== 0 || riskCategory === 'replace_soon') return 'failed';
  if ((status & STATUS_SCRUTINY_FAILED) !== 0 || riskCategory === 'plan_replacement')
    return 'warning';
  // Missing SMART data is never "ok" (R59). Explicit failure flags above still win.
  if (!hasSmart) return 'unknown';
  return 'ok';
}

/** R59. Undefined (type unknown) when the record has no rotational speed and is not NVMe. */
function mapDriveType(d: RawEntry['device']): DriveType | undefined {
  if (d.device_protocol.toLowerCase() === 'nvme' || d.device_type.toLowerCase() === 'nvme')
    return 'NVMe';
  if (d.rotational_speed === undefined) return undefined;
  return d.rotational_speed === 0 ? 'SSD' : 'HDD';
}

function toIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** Link back to Scrutiny's own device page. */
export function detailUrlFor(baseUrl: string, deviceId: string): string | undefined {
  return deviceId ? `${baseUrl}/web/device/${encodeURIComponent(deviceId)}` : undefined;
}

export function mapEntry(entry: RawEntry, baseUrl: string): Observation {
  const d = entry.device;
  const serial = d.serial_number.trim() || undefined;
  const wwnRaw = d.wwn.trim();
  // Some NVMe devices report their (lowercase) serial as the "WWN". That is not a WWN and would
  // be a bogus fallback match key, so it is dropped.
  const wwn = wwnRaw && wwnRaw.toUpperCase() !== (serial ?? '').toUpperCase() ? wwnRaw : undefined;
  const smart = entry.smart ?? undefined;
  const model = d.model_name.trim();
  const formFactor = d.form_factor.trim();
  const driveType = mapDriveType(d);
  const detailUrl = detailUrlFor(baseUrl, d.device_id);
  return {
    ...(serial ? { serial } : {}),
    ...(wwn ? { wwn } : {}),
    ...(model ? { model } : {}),
    ...(d.capacity > 0 ? { capacityBytes: d.capacity } : {}),
    ...(driveType ? { driveType } : {}),
    ...(formFactor ? { formFactor } : {}),
    health: mapHealth(d.device_status, smart?.risk_category, smart !== undefined),
    lastReportedAt: toIso(smart?.collector_date) ?? toIso(d.UpdatedAt) ?? NEVER_REPORTED,
    state: d.archived ? 'decommissioned' : 'active',
    ...(smart?.temp !== undefined ? { temperatureC: smart.temp } : {}),
    ...(detailUrl ? { detailUrl } : {}),
  };
}

/** Pure mapping: raw summary JSON to observations. Malformed single entries are skipped. */
export function mapSummary(raw: unknown, baseUrl: string): Observation[] {
  const envelope = rawSummarySchema.parse(raw);
  const out: Observation[] = [];
  for (const value of Object.values(envelope.data.summary)) {
    const entry = rawEntrySchema.safeParse(value);
    if (entry.success) out.push(mapEntry(entry.data, baseUrl));
  }
  return out;
}
