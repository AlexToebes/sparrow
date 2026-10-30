import { useMemo, useState } from 'react';
import { Button, Text, TextInput } from '@mantine/core';
import {
  CONFLICT_REASON_MAX,
  CONFLICT_REASON_SUGGESTIONS,
  type Drive,
  type DriveConflictView,
} from '@sparrow/shared';
import { useAddConflict } from '../api/conflictMutations';
import { useDrives, useLayout } from '../api/hooks';
import { slotLabel } from '../lib/health';
import { ApiErrorAlert } from './ApiErrorAlert';
import { SparePicker } from './SparePicker';
import { StepFlow, type StepDef } from './StepFlow';

const STEPS: StepDef<'drive' | 'reason'>[] = [
  { key: 'drive', title: 'Choose the other drive' },
  { key: 'reason', title: 'Why? (optional)' },
];

/**
 * R78: pick another drive (any status, with search) and an optional reason, then mark the two as not
 * recommended together. A phone gets the fullscreen step flow with a sticky footer. Mount only while open.
 */
export function AddConflictDialog({
  drive,
  existing,
  onClose,
}: {
  drive: Drive;
  /** The pairs this drive is already in: those drives are not offered again. */
  existing: DriveConflictView[];
  onClose: () => void;
}) {
  const add = useAddConflict(drive.id);
  const all = useDrives();
  const layout = useLayout();
  const [step, setStep] = useState<'drive' | 'reason'>('drive');
  const [otherId, setOtherId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const offered = useMemo(() => {
    const paired = new Set(existing.map((c) => c.otherDriveId));
    return (all.data ?? []).filter((d) => d.id !== drive.id && !paired.has(d.id));
  }, [all.data, existing, drive.id]);
  const bayLabels = useMemo(
    () =>
      new Map(
        (layout.data?.enclosures ?? []).flatMap((e) =>
          e.grids.flatMap((g) =>
            g.slots.map((sl) => [sl.id, `${g.name} · ${slotLabel(sl)}`] as const),
          ),
        ),
      ),
    [layout.data],
  );
  const other = offered.find((d) => d.id === otherId) ?? null;
  const trimmed = reason.trim();
  const tooLong = trimmed.length > CONFLICT_REASON_MAX;

  const save = () => {
    if (!other || tooLong) return;
    add.mutate(
      { otherDriveId: other.id, reason: trimmed === '' ? null : trimmed },
      { onSuccess: onClose },
    );
  };

  const footer = (
    <>
      {step === 'drive' ? (
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
      ) : (
        <Button variant="default" onClick={() => setStep('drive')}>
          Back
        </Button>
      )}
      {step === 'drive' ? (
        <Button disabled={!other} onClick={() => setStep('reason')}>
          Next
        </Button>
      ) : (
        <Button loading={add.isPending} disabled={tooLong} onClick={save}>
          Mark as not recommended together
        </Button>
      )}
    </>
  );

  return (
    <StepFlow
      title="Not recommended with"
      steps={STEPS}
      current={step}
      onClose={onClose}
      footer={footer}
    >
      {step === 'drive' ? (
        <>
          <Text fw={500} size="sm" mb={6}>
            Which drive should not run together with <span className="mono">{drive.serial}</span>?
          </Text>
          <SparePicker
            spares={offered}
            value={otherId}
            onChange={setOtherId}
            loading={all.isPending}
            label="Other drive"
            statuses={['spare', 'installed', 'retired']}
            bayLabels={bayLabels}
            noun="drives"
          />
        </>
      ) : (
        <>
          <Text size="sm" mb="sm">
            <strong className="mono">{drive.serial}</strong> and{' '}
            <strong className="mono">{other?.serial}</strong> will be marked as not recommended
            together. Sparrow warns about it on pools and when choosing a spare; it never blocks
            anything.
          </Text>
          <TextInput
            label="Reason (optional)"
            placeholder="For example: same batch"
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
            maxLength={CONFLICT_REASON_MAX + 20}
            error={tooLong ? `At most ${CONFLICT_REASON_MAX} characters` : null}
          />
          <div
            className="preset-chips"
            role="group"
            aria-label="Reason suggestions"
            aria-live="off"
          >
            {CONFLICT_REASON_SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                className="preset-chip"
                aria-pressed={trimmed === s}
                onClick={() => setReason(s)}
              >
                {s}
              </button>
            ))}
          </div>
          <ApiErrorAlert error={add.error} />
        </>
      )}
    </StepFlow>
  );
}
