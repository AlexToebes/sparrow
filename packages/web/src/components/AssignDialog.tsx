import { useMemo, useState, type ReactNode } from 'react';
import { Alert, Button, Modal, Text } from '@mantine/core';
import type { Drive, MembershipRole } from '@sparrow/shared';
import { ApiError } from '../api/client';
import { occupantFromError, useAssignDrive, type OccupantInput } from '../api/driveMutations';
import { useDrives, useLayout } from '../api/hooks';
import { slotLabel } from '../lib/health';
import {
  NOT_RECORDED_HINT,
  OptionalDateField,
  OutcomeFields,
  PoolRoleFields,
  initialOutcome,
  outcomeToResolution,
  usePoolRole,
} from './AssignFields';
import { driveLabel, installedOnError, todayLocal } from './RetireFields';
import { SlotPicker } from './SlotPicker';
import { SparePicker } from './SparePicker';

/** Slot, pool, role and occupant resolution: the part of an assignment every flow shares. */
export interface PlacementInput {
  slotId: string;
  poolId: string | null;
  role?: MembershipRole;
  occupant?: OccupantInput;
  /**
   * R68: YYYY-MM-DD the drive went in; null = "not recorded" (explicit, so the server does not
   * default it to today); absent = leave it to the server (inbox: not recorded).
   */
  installedOn?: string | null;
}

/**
 * Replaces the plain assign call, so the inbox can reuse the slot, pool, role and occupant steps (R22, R37).
 * `run` performs the request and reports back; an occupied-slot 409 is handled by the dialog itself.
 */
export interface PlacementTarget {
  /** What is being placed, shown above the slot picker. */
  summary: ReactNode;
  /** Serial for the occupant step's wording. */
  incomingSerial: string;
  pending: boolean;
  run: (
    input: PlacementInput,
    callbacks: { onSuccess: () => void; onError: (e: Error) => void },
  ) => void;
}

interface AssignDialogProps {
  placement?: PlacementTarget;
  onClose: () => void;
  /** Fixed target slot (from an empty slot's "+ Assign"), or leave out to pick one. */
  slotId?: string | null;
  /** Fixed drive (from a spare's detail), or leave out to pick a spare. */
  driveId?: string | null;
}

/**
 * Assign a spare to a slot (R8, R35). The slot is chosen on the bay grids (R70) and the spare from
 * cards. Retired drives are never offered. When the slot is occupied the
 * dialog moves to a resolution step for the occupant (R37, R62) and submits it with the assignment.
 * Mount it only while open: its state starts fresh each time.
 */
export function AssignDialog({
  placement,
  onClose,
  slotId: fixedSlot = null,
  driveId: fixedDrive = null,
}: AssignDialogProps) {
  const layout = useLayout();
  const spares = useDrives('spare');
  const allDrives = useDrives();
  const assign = useAssignDrive();

  // The slot starts as the one the dialog was opened from (an empty slot's "+ Assign") and can be changed on the grid.
  const [slotId, setSlotId] = useState<string | null>(fixedSlot);
  const [driveId, setDriveId] = useState<string | null>(fixedDrive);
  const poolRole = usePoolRole(slotId);
  const { poolValue, roleValue } = poolRole;
  // R68: drives found in the NAS (the inbox flow) start with no date; moving a spare in starts at today.
  const [installedOn, setInstalledOn] = useState(() => (placement ? '' : todayLocal()));
  const [step, setStep] = useState<'form' | 'occupant'>('form');
  const [error, setError] = useState<string | null>(null);
  const [apiOccupantId, setApiOccupantId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState(() => initialOutcome(fixedDrive));

  const slotById = useMemo(() => {
    const multi = (layout.data?.enclosures.length ?? 0) > 1;
    const m = new Map<string, { gridName: string; label: string; driveId: string | null }>();
    for (const enc of layout.data?.enclosures ?? [])
      for (const g of enc.grids)
        for (const s of g.slots)
          m.set(s.id, {
            gridName: multi ? `${enc.name} / ${g.name}` : g.name,
            label: slotLabel(s),
            driveId: s.driveId,
          });
    return m;
  }, [layout.data]);
  const driveById = useMemo(
    () => new Map((allDrives.data ?? []).map((d) => [d.id, d])),
    [allDrives.data],
  );

  const targetSlot = slotId ? (slotById.get(slotId) ?? null) : null;
  const incoming: Drive | null =
    driveId !== null
      ? (driveById.get(driveId) ?? spares.data?.find((d) => d.id === driveId) ?? null)
      : null;
  const occupantId = targetSlot?.driveId ?? apiOccupantId;
  const occupant = occupantId ? (driveById.get(occupantId) ?? null) : null;

  const submit = (resolution?: OccupantInput) => {
    if (!slotId || (!driveId && !placement)) return;
    setError(null);
    const input: PlacementInput = {
      slotId,
      poolId: poolValue,
      ...(poolValue !== null ? { role: roleValue as MembershipRole } : {}),
      // Non-inbox: an emptied field is an explicit null (not recorded); inbox: omitted = not recorded.
      ...(installedOn !== '' ? { installedOn } : placement ? {} : { installedOn: null }),
      ...(resolution ? { occupant: resolution } : {}),
    };
    const callbacks = {
      onSuccess: onClose,
      onError: (e: Error) => {
        if (e instanceof ApiError && e.status === 409) {
          const occ = occupantFromError(e.details);
          if (occ && !resolution) {
            setApiOccupantId(occ.driveId);
            setStep('occupant');
            return;
          }
        }
        setError(e instanceof ApiError ? e.message : 'Could not assign the drive.');
      },
    };
    if (placement) placement.run(input, callbacks);
    else assign.mutate({ driveId: driveId!, ...input }, callbacks);
  };

  const onAssignClick = () => {
    if (!slotId || (!driveId && !placement)) {
      setError(placement ? 'Choose a slot.' : 'Choose both a slot and a drive.');
      return;
    }
    const dateProblem = installedOnError(installedOn);
    if (dateProblem) {
      setError(dateProblem);
      return;
    }
    if (occupantId) {
      // Without a driveId (a record not created yet) the server defaults replaced-by to the incoming drive (R62).
      setOutcome((o) => ({ ...o, retire: { ...o.retire, replacedByDriveId: driveId } }));
      setError(null);
      setStep('occupant');
      return;
    }
    submit();
  };

  const submitResolution = () => {
    const r = outcomeToResolution(outcome);
    if (r.error !== undefined) {
      setError(r.error);
      return;
    }
    submit(r.resolution);
  };

  const title =
    step === 'occupant' ? `${targetSlot?.label ?? 'Slot'} is occupied` : 'Assign to a slot';
  const pending = placement ? placement.pending : assign.isPending;

  return (
    <Modal opened onClose={onClose} title={title} centered size="lg">
      {step === 'form' ? (
        <>
          {placement ? (
            <Text>{placement.summary}</Text>
          ) : fixedDrive === null ? (
            <>
              <Text fw={500} size="sm" mb={6}>
                Which spare goes in?
              </Text>
              <SparePicker
                spares={spares.data ?? []}
                value={driveId}
                onChange={setDriveId}
                loading={spares.isPending}
              />
            </>
          ) : (
            <Text>
              Assign <strong className="mono">{incoming?.serial ?? '…'}</strong>
              {incoming ? ` (${driveLabel(incoming).split(' · ').slice(1).join(' · ')})` : ''}
            </Text>
          )}
          <Text fw={500} size="sm" mt="md" mb={6}>
            Which slot? Tap a bay.
          </Text>
          <SlotPicker
            value={slotId}
            label="Slot"
            onChange={(id) => {
              setSlotId(id);
              setApiOccupantId(null);
              poolRole.reset();
            }}
          />
          {slotId ? <PoolRoleFields state={poolRole} /> : null}
          <OptionalDateField
            label="Installed on (optional)"
            description={NOT_RECORDED_HINT}
            value={installedOn}
            onChange={setInstalledOn}
          />
          {occupantId && slotId ? (
            <Alert color="yellow" mt="sm">
              This slot is occupied{occupant ? ` by ${occupant.serial}` : ''}. You will choose what
              happens to it next.
            </Alert>
          ) : null}
          {error ? (
            <Alert color="red" mt="sm">
              {error}
            </Alert>
          ) : null}
          <div className="dialog-actions">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={onAssignClick}
              loading={pending}
              disabled={
                !slotId || (!driveId && !placement) || (slotId !== null && poolRole.pending)
              }
            >
              {occupantId ? 'Next' : 'Assign'}
            </Button>
          </div>
        </>
      ) : (
        <>
          <Text>
            <strong className="mono">{occupant?.serial ?? 'Another drive'}</strong> is in{' '}
            {targetSlot?.label ?? 'this slot'}
            {occupant ? ` (${driveLabel(occupant).split(' · ').slice(1).join(' · ')})` : ''}. What
            should happen to it before{' '}
            <strong className="mono">
              {incoming?.serial ?? placement?.incomingSerial ?? 'the new drive'}
            </strong>{' '}
            goes in?
          </Text>
          {occupant ? (
            <OutcomeFields
              state={outcome}
              onChange={setOutcome}
              outgoing={occupant}
              drives={allDrives.data ?? []}
              idPrefix="occ-retire"
            />
          ) : null}
          {error ? (
            <Alert color="red" mt="sm">
              {error}
            </Alert>
          ) : null}
          <div className="dialog-actions">
            <Button
              variant="default"
              onClick={() => {
                setError(null);
                setStep('form');
              }}
            >
              Back
            </Button>
            <Button
              color={outcome.choice === 'spare' ? 'indigo' : 'red'}
              loading={pending}
              onClick={submitResolution}
            >
              {outcome.choice === 'spare'
                ? 'Move to spares and assign'
                : outcome.choice === 'retire'
                  ? 'Retire it and assign'
                  : 'Send for RMA and assign'}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
