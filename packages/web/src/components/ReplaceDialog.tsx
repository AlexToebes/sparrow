import { useState } from 'react';
import { Alert, Button, Modal, Radio, Select, Text, Textarea } from '@mantine/core';
import { RETIREMENT_REASONS, type Drive, type RetirementReason } from '@sparrow/shared';
import { ApiError } from '../api/client';
import { useAssignDrive, type OccupantInput } from '../api/driveMutations';
import { useDrives, usePools } from '../api/hooks';
import { formatBytes } from '../lib/format';
import { NOT_RECORDED_HINT, OptionalDateField, PoolRoleFields, usePoolRole } from './AssignFields';
import { installedOnError, todayLocal } from './RetireFields';
import { SlotPicker } from './SlotPicker';
import { SparePicker } from './SparePicker';

type Step = 'incoming' | 'date' | 'outgoing' | 'confirm';
const STEPS: Step[] = ['incoming', 'date', 'outgoing', 'confirm'];
const STEP_TITLE: Record<Step, string> = {
  incoming: 'Choose the replacement',
  date: 'When was it swapped?',
  outgoing: 'What happens to the old drive?',
  confirm: 'Confirm',
};
const REASON_LABEL: Record<RetirementReason, string> = {
  failed: 'Failed',
  replaced: 'Replaced',
  other: 'Other',
};
type Choice = 'spare' | 'retire' | 'rma';

const capacityOf = (d: Drive | null) =>
  d ? formatBytes(d.capacityBytes) || 'capacity unknown' : '—';

/**
 * R70: "Replace" on an installed drive. The bay is fixed (shown on its grid for context). Steps, in
 * the order people think: pick the replacement (suggested by type and size), the optional swap date
 * (the new drive's install date and the old drive's removal, retirement or RMA date), what happens
 * to the old drive (R27, R62, R69), then confirm. One POST /api/slots/:id/assign carries the swap
 * (R37). Mount only while open.
 */
export function ReplaceDialog({
  drive,
  where,
  onClose,
}: {
  drive: Drive;
  where: string | null;
  onClose: () => void;
}) {
  const slotId = drive.slotId!;
  const spares = useDrives('spare');
  const pools = usePools();
  const assign = useAssignDrive();
  const poolRole = usePoolRole(slotId);

  const [step, setStep] = useState<Step>('incoming');
  const [incomingId, setIncomingId] = useState<string | null>(null);
  // R68, R69: one optional date for both drives; empty = not recorded.
  const [swapDate, setSwapDate] = useState(todayLocal);
  const [choice, setChoice] = useState<Choice>('spare');
  const [reason, setReason] = useState<RetirementReason | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const incoming = (spares.data ?? []).find((d) => d.id === incomingId) ?? null;
  const poolName = poolRole.poolValue
    ? (pools.data?.find((p) => p.id === poolRole.poolValue)?.name ?? 'a pool')
    : null;
  const roleWord = poolRole.roleValue === 'hot-spare' ? 'hot spare' : 'data';
  // R60: retire and RMA use the swap date as well; empty = not recorded.
  const swapOrNull = swapDate === '' ? null : swapDate;

  const go = (next: Step) => {
    setError(null);
    setStep(next);
  };

  const buildOccupant = (): { occupant: OccupantInput } | { error: string } => {
    const trimmed = note.trim() === '' ? null : note.trim();
    if (choice === 'spare') {
      return { occupant: { action: 'spare', removedOn: swapOrNull } };
    }
    if (choice === 'retire' && reason === null) return { error: 'Choose a reason.' };
    if (choice === 'rma') {
      return { occupant: { action: 'rma', date: swapOrNull, note: trimmed } };
    }
    return {
      occupant: {
        action: 'retire',
        reason: reason!,
        date: swapOrNull,
        note: trimmed,
        // The incoming drive is the replacement whatever the reason.
        replacedByDriveId: incoming!.id,
      },
    };
  };

  const toDate = () => {
    if (incoming) go('date');
  };
  const toOutgoing = () => {
    const problem = installedOnError(swapDate);
    if (problem) return setError(problem.replace('installation', 'swap'));
    go('outgoing');
  };
  const review = () => {
    const built = buildOccupant();
    if ('error' in built) return setError(built.error);
    go('confirm');
  };

  const confirm = () => {
    const built = buildOccupant();
    if (!incoming || 'error' in built) return;
    setError(null);
    assign.mutate(
      {
        slotId,
        driveId: incoming.id,
        poolId: poolRole.poolValue,
        ...(poolRole.poolValue !== null ? { role: poolRole.roleValue } : {}),
        installedOn: swapOrNull,
        occupant: built.occupant,
      },
      {
        onSuccess: onClose,
        onError: (e) =>
          setError(e instanceof ApiError ? e.message : 'Could not replace the drive.'),
      },
    );
  };

  const mini = (
    <SlotPicker value={slotId} readOnly onlyGridOfValue label="The bay being replaced" />
  );
  const oldWord =
    choice === 'spare'
      ? 'back to spares'
      : choice === 'rma'
        ? 'sent for RMA'
        : `retired (${reason ? REASON_LABEL[reason].toLowerCase() : '…'})`;

  return (
    <Modal opened onClose={onClose} title={`Replace ${drive.serial}`} centered size="lg">
      <Text size="xs" c="dimmed" mb="xs">
        Step {STEPS.indexOf(step) + 1} of {STEPS.length} · {STEP_TITLE[step]}
      </Text>

      {step === 'incoming' ? (
        <>
          {mini}
          <div className="swap-compare" role="group" aria-label="Swap capacity comparison">
            <div>
              <Text size="xs" c="dimmed">
                Out
              </Text>
              <Text className="mono" fw={600}>
                {drive.serial}
              </Text>
              <Text className="mono">{capacityOf(drive)}</Text>
            </div>
            <span className="swap-arrow" aria-hidden="true">
              →
            </span>
            <div>
              <Text size="xs" c="dimmed">
                In
              </Text>
              <Text className="mono" fw={600}>
                {incoming?.serial ?? 'Choose below'}
              </Text>
              <Text className="mono">{incoming ? capacityOf(incoming) : '—'}</Text>
            </div>
          </div>
          <Text fw={500} size="sm" mb={6}>
            Which spare goes in?
          </Text>
          <SparePicker
            spares={spares.data ?? []}
            value={incomingId}
            onChange={setIncomingId}
            loading={spares.isPending}
            outgoing={drive}
          />
          <div className="dialog-actions">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!incoming} onClick={toDate}>
              Next
            </Button>
          </div>
        </>
      ) : null}

      {step === 'date' && incoming ? (
        <>
          <Text>
            <strong className="mono">{incoming.serial}</strong> ({capacityOf(incoming)}) replaces{' '}
            <strong className="mono">{drive.serial}</strong> ({capacityOf(drive)}) in{' '}
            {where ?? 'the slot'}.
          </Text>
          <OptionalDateField
            label="When was it swapped? (optional)"
            description={NOT_RECORDED_HINT}
            value={swapDate}
            onChange={setSwapDate}
            error={error}
          />
          <div className="dialog-actions">
            <Button variant="default" onClick={() => go('incoming')}>
              Back
            </Button>
            <Button onClick={toOutgoing}>Next</Button>
          </div>
        </>
      ) : null}

      {step === 'outgoing' && incoming ? (
        <>
          <Text>
            What happens to <strong className="mono">{drive.serial}</strong> ({capacityOf(drive)})?
          </Text>
          <Radio.Group
            value={choice}
            onChange={(v) => setChoice(v as Choice)}
            mt="sm"
            aria-label="What happens to the old drive"
          >
            <Radio
              value="spare"
              label="Back to spares"
              description="Still works — e.g. too small"
              mb="xs"
            />
            <Radio value="retire" label="Retire" description="Broken or done" mb="xs" />
            <Radio value="rma" label="Send for RMA" mb="xs" />
          </Radio.Group>
          {choice === 'retire' ? (
            <>
              <Select
                label="Reason"
                required
                placeholder="Why is it being retired?"
                data={RETIREMENT_REASONS.map((r) => ({ value: r, label: REASON_LABEL[r] }))}
                value={reason}
                onChange={(v) => setReason(v as RetirementReason | null)}
                allowDeselect={false}
              />
              <Text size="sm" mt="xs">
                Replaced by <strong className="mono">{incoming.serial}</strong> (
                {capacityOf(incoming)}).
              </Text>
            </>
          ) : null}
          {choice !== 'spare' ? (
            <>
              <Textarea
                label="Note (optional)"
                autosize
                minRows={2}
                mt="sm"
                value={note}
                onChange={(e) => setNote(e.currentTarget.value)}
              />
            </>
          ) : null}
          <details className="pool-role-details">
            <summary>Pool & role: {poolName ? `${poolName} · ${roleWord}` : 'no pool'}</summary>
            <PoolRoleFields state={poolRole} />
          </details>
          {error ? (
            <Alert color="red" mt="sm">
              {error}
            </Alert>
          ) : null}
          <div className="dialog-actions">
            <Button variant="default" onClick={() => go('date')}>
              Back
            </Button>
            <Button disabled={poolRole.pending} onClick={review}>
              Review
            </Button>
          </div>
        </>
      ) : null}

      {step === 'confirm' && incoming ? (
        <>
          {mini}
          <p className="swap-line">
            {where ? `${where}: ` : ''}
            <strong className="mono">{drive.serial}</strong> ({capacityOf(drive)}) →{' '}
            <strong className="mono">{incoming.serial}</strong> ({capacityOf(incoming)}), swapped on{' '}
            {swapDate === '' ? 'not recorded' : swapDate}, old drive: {oldWord}.
          </p>
          <Text size="sm" c="dimmed">
            {poolName ? `New drive joins ${poolName} as ${roleWord}.` : 'New drive has no pool.'}
          </Text>
          {error ? (
            <Alert color="red" mt="sm">
              {error}
            </Alert>
          ) : null}
          <div className="dialog-actions">
            <Button variant="default" onClick={() => go('outgoing')}>
              Back
            </Button>
            <Button
              color={choice === 'spare' ? 'indigo' : 'red'}
              loading={assign.isPending}
              onClick={confirm}
            >
              Confirm replacement
            </Button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
