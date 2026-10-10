import { Select, Text, Textarea, TextInput } from '@mantine/core';
import { RETIREMENT_REASONS, type Drive, type RetirementReason } from '@sparrow/shared';
import { formatBytes } from '../lib/format';

export interface RetireValues {
  reason: RetirementReason | null;
  date: string;
  replacedByDriveId: string | null;
  note: string;
}

export const todayLocal = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const emptyRetireValues = (): RetireValues => ({
  reason: null,
  date: todayLocal(),
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
        comboboxProps={{ withinPortal: false }}
      />
      <TextInput
        id={`${id}-date`}
        label="Date"
        type="date"
        required
        value={values.date}
        onChange={(e) => set({ date: e.currentTarget.value })}
        mt="sm"
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
        comboboxProps={{ withinPortal: false }}
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

/** Validates the shared fields; returns an error message or null. */
export function retireValuesError(v: RetireValues): string | null {
  if (v.reason === null) return 'Choose a reason.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) return 'Enter a valid date.';
  return null;
}
