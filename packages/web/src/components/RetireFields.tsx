import { Select, Text, Textarea } from '@mantine/core';
import { RETIREMENT_REASONS, type Drive, type RetirementReason } from '@sparrow/shared';
import { formatBytes } from '../lib/format';
import { todayLocal } from './dates';
import { OptionalDateField } from './OptionalDateField';

export { todayLocal };

export interface RetireValues {
  reason: RetirementReason | null;
  /** R60: YYYY-MM-DD; empty = retirement date not recorded. */
  date: string;
  replacedByDriveId: string | null;
  note: string;
}

/** R68: an installation date is optional (empty = not recorded); if given it must be a real date, not later than today (local). */
export function installedOnError(value: string): string | null {
  if (value === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    return 'Enter the date the drive was installed.';
  }
  return value > todayLocal() ? 'The installation date cannot be in the future.' : null;
}

/** R60: the reason has no default; the date starts at `date` (today, or '' = not recorded). */
export const emptyRetireValues = (date: string = todayLocal()): RetireValues => ({
  reason: null,
  date,
  replacedByDriveId: null,
  note: '',
});

const REASON_LABEL: Record<RetirementReason, string> = {
  failed: 'Failed',
  replaced: 'Replaced',
  other: 'Other',
};

export const driveLabel = (d: Drive): string =>
  [d.serial, d.model, formatBytes(d.capacityBytes) || null].filter(Boolean).join(' · ');

interface RetireFieldsProps {
  /** The drive being retired, for the capacity comparison. */
  drive: Drive;
  /** Candidates for "replaced by": every other drive. */
  candidates: Drive[];
  values: RetireValues;
  onChange: (values: RetireValues) => void;
  idPrefix?: string;
}

/** Reason, date, replaced-by and note (R60, R61, R62). Shared by the retire dialog and the occupied-slot dialog. */
export function RetireFields({ drive, candidates, values, onChange, idPrefix }: RetireFieldsProps) {
  const set = (patch: Partial<RetireValues>) => onChange({ ...values, ...patch });
  const replacement = candidates.find((c) => c.id === values.replacedByDriveId) ?? null;
  const id = idPrefix ?? 'retire';
  return (
    <>
      <Select
        label="Reason"
        required
        placeholder="Why is it being retired?"
        data={RETIREMENT_REASONS.map((r) => ({ value: r, label: REASON_LABEL[r] }))}
        value={values.reason}
        onChange={(v) => set({ reason: v as RetirementReason | null })}
        allowDeselect={false}
      />
      <OptionalDateField
        id={`${id}-date`}
        label="Retirement date (optional)"
        description={RETIREMENT_DATE_HINT}
        value={values.date}
        onChange={(date) => set({ date })}
        error={retirementDateError(values.date)}
      />
      <Select
        label="Replaced by"
        description="Optional. Link the drive that took its place."
        placeholder="No replacement"
        clearable
        searchable
        data={candidates.map((c) => ({
          value: c.id,
          label: `${driveLabel(c)} (${c.status})`,
        }))}
        value={values.replacedByDriveId}
        onChange={(v) => set({ replacedByDriveId: v })}
        mt="sm"
      />
      {replacement ? (
        <div className="compare" aria-label="Capacity comparison">
          <div>
            <Text size="xs" c="dimmed">
              Retiring
            </Text>
            <Text className="mono" fw={600}>
              {drive.serial}
            </Text>
            <Text className="mono">{formatBytes(drive.capacityBytes) || 'capacity unknown'}</Text>
          </div>
          <div>
            <Text size="xs" c="dimmed">
              Replaced by
            </Text>
            <Text className="mono" fw={600}>
              {replacement.serial}
            </Text>
            <Text className="mono">
              {formatBytes(replacement.capacityBytes) || 'capacity unknown'}
            </Text>
          </div>
        </div>
      ) : null}
      <Textarea
        label="Note"
        autosize
        minRows={2}
        value={values.note}
        onChange={(e) => set({ note: e.currentTarget.value })}
        mt="sm"
      />
    </>
  );
}

export const RETIREMENT_DATE_HINT =
  'Leave empty if you don’t know — better ‘not recorded’ than a guess.';

/** R60: a retirement date is optional (empty = not recorded); if given it must be a real date, not later than today (local). */
export function retirementDateError(value: string): string | null {
  if (value === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    return 'Enter the date the drive was retired.';
  }
  return value > todayLocal() ? 'The retirement date cannot be in the future.' : null;
}

/** Validates the shared fields; returns an error message or null. */
export function retireValuesError(v: RetireValues): string | null {
  if (v.reason === null) return 'Choose a reason.';
  return retirementDateError(v.date);
}

/** R69: a removal date is optional (empty = not recorded); if given it must be a real date, not later than today (local). */
export function removedOnError(value: string): string | null {
  if (value === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    return 'Enter the date the drive was taken out.';
  }
  return value > todayLocal() ? 'The removal date cannot be in the future.' : null;
}
