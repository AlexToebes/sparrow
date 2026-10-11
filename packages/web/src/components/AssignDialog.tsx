import { useMemo, useState, type ReactNode } from 'react';
import { Alert, Button, Text } from '@mantine/core';
import type { Drive, MembershipRole } from '@sparrow/shared';
import { ApiError } from '../api/client';
import { occupantFromError, useAssignDrive, type OccupantInput } from '../api/driveMutations';
import { useDrives, useLayout, usePools } from '../api/hooks';
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
import { StepFlow, type StepDef } from './StepFlow';

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
  /** What is being placed; the slot step continues the sentence ("… and put it in"). */
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

type StepKey = 'slot' | 'drive' | 'occupant' | 'details' | 'confirm';
const STEP_TITLE: Record<StepKey, string> = {
  slot: 'Choose the slot',
  drive: 'Choose the drive',
  occupant: 'What happens to the drive in this bay?',
  details: 'Details',
  confirm: 'Confirm',
};

/**
 * Assign a spare to a slot (R8, R35) as steps, one decision each (R70): the slot on the bay grids
 * (alone, skipped when opened from a slot), the spare on cards (skipped when a drive is given),
 * what happens to the occupant when the slot is occupied (R37, R62), pool, role and install date,
 * then a confirmation that makes the one API call. Retired drives are never offered.
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
  const pools = usePools();
  const assign = useAssignDrive();

  // The slot starts as the one the dialog was opened from (an empty slot's "+ Assign") and can be changed on the grid.
  const [slotId, setSlotId] = useState<string | null>(fixedSlot);
  const [driveId, setDriveId] = useState<string | null>(fixedDrive);
  // Opened from a slot, the slot step is skipped until "Change" brings it back.
  const [slotStepShown, setSlotStepShown] = useState(fixedSlot === null);
  const poolRole = usePoolRole(slotId);
  const { poolValue, roleValue } = poolRole;
  // R68: drives found in the NAS (the inbox flow) start with no date; moving a spare in starts at today.
  const [installedOn, setInstalledOn] = useState(() => (placement ? '' : todayLocal()));
  const [current, setCurrent] = useState<StepKey>(fixedSlot === null ? 'slot' : 'drive');
  const [error, setError] = useState<string | null>(null);
  const [apiOccupantId, setApiOccupantId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState(() => initialOutcome());

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
  const pending = placement ? placement.pending : assign.isPending;

  // Only the steps that apply: the count in the header follows.
  const needsDrive = fixedDrive === null && !placement;
  const steps: StepDef<StepKey>[] = (
    [
      ...(slotStepShown ? ['slot' as const] : []),
      ...(needsDrive ? ['drive' as const] : []),
      ...(slotId && occupantId ? ['occupant' as const] : []),
      'details' as const,
      'confirm' as const,
    ] satisfies StepKey[]
  ).map((key) => ({ key, title: STEP_TITLE[key] }));
  const index = Math.max(
    0,
    steps.findIndex((s) => s.key === current),
  );
  const goTo = (key: StepKey) => {
    setError(null);
    setCurrent(key);
  };

  const incomingDetail = incoming ? driveLabel(incoming).split(' · ').slice(1).join(' · ') : '';

  const resolutionFor = () => {
    if (!occupantId) return { resolution: undefined, error: undefined } as const;
    return outcomeToResolution(outcome);
  };

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
            // The slot filled up since the layout loaded: ask what to do with its drive (R37).
            setApiOccupantId(occ.driveId);
            setCurrent('occupant');
            return;
          }
        }
        setError(e instanceof ApiError ? e.message : 'Could not assign the drive.');
      },
    };
    if (placement) placement.run(input, callbacks);
    else assign.mutate({ driveId: driveId!, ...input }, callbacks);
  };

  const next = () => {
    if (current === 'occupant') {
      const r = outcomeToResolution(outcome);
      if (r.error !== undefined) return setError(r.error);
    }
    if (current === 'details') {
      const dateProblem = installedOnError(installedOn);
      if (dateProblem) return setError(dateProblem);
    }
    const to = steps[index + 1];
    if (to) goTo(to.key);
  };
  const back = () => {
    const to = steps[index - 1];
    if (to) goTo(to.key);
  };
  const confirm = () => {
    const r = resolutionFor();
    if (r.error !== undefined) {
      goTo('occupant');
      setError(r.error);
      return;
    }
    submit(r.resolution);
  };

  const valid =
    current === 'slot'
      ? slotId !== null
      : current === 'drive'
        ? driveId !== null
        : current === 'details'
          ? !poolRole.pending
          : true;
  const last = current === 'confirm';

  const poolName = poolValue
    ? (pools.data?.find((p) => p.id === poolValue)?.name ?? 'a pool')
    : null;
  const occupantWord =
    outcome.choice === 'spare'
      ? 'goes back to spares'
      : outcome.choice === 'rma'
        ? 'is sent for RMA'
        : 'is retired';

  const footer = (
    <>
      {index === 0 ? (
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
      ) : (
        <Button variant="default" onClick={back}>
          Back
        </Button>
      )}
      {last ? (
        <Button
          color={occupantId && outcome.choice !== 'spare' ? 'red' : 'indigo'}
          loading={pending}
          onClick={confirm}
        >
          {!occupantId
            ? 'Assign'
            : outcome.choice === 'spare'
              ? 'Move to spares and assign'
              : outcome.choice === 'retire'
                ? 'Retire it and assign'
                : 'Send for RMA and assign'}
        </Button>
      ) : (
        <Button disabled={!valid} onClick={next}>
          Next
        </Button>
      )}
    </>
  );

  const errorAlert = error ? (
    <Alert color="red" mt="sm">
      {error}
    </Alert>
  ) : null;

  return (
    <StepFlow
      title="Assign to a slot"
      steps={steps}
      current={current}
      onClose={onClose}
      footer={footer}
    >
      {/* Opened from a slot: remind which one, with a way back to the picker. */}
      {!slotStepShown && index === 0 && targetSlot ? (
        <div className="step-summary">
          <Text size="sm">
            <strong>{targetSlot.label}</strong> · {targetSlot.gridName}
          </Text>
          <Button
            size="compact-sm"
            variant="subtle"
            onClick={() => {
              setSlotStepShown(true);
              goTo('slot');
            }}
          >
            Change
          </Button>
        </div>
      ) : null}

      {current === 'slot' ? (
        <>
          <Text mb="xs">
            {placement ? (
              <>{placement.summary} the bay you tap below.</>
            ) : incoming ? (
              <>
                Assign <strong className="mono">{incoming.serial}</strong> (
                {driveLabel(incoming).split(' · ').slice(1).join(' · ')}). Tap the bay it goes in.
              </>
            ) : (
              'Tap the bay the drive goes in.'
            )}
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
        </>
      ) : null}

      {current === 'drive' ? (
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
      ) : null}

      {current === 'occupant' ? (
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
            <OutcomeFields state={outcome} onChange={setOutcome} idPrefix="occ-retire" />
          ) : null}
        </>
      ) : null}

      {current === 'details' ? (
        <>
          <PoolRoleFields state={poolRole} />
          <OptionalDateField
            label="Installed on (optional)"
            description={NOT_RECORDED_HINT}
            value={installedOn}
            onChange={setInstalledOn}
          />
        </>
      ) : null}

      {current === 'confirm' ? (
        <>
          <Text>
            <strong className="mono">
              {incoming?.serial ?? placement?.incomingSerial ?? 'The drive'}
            </strong>
            {incomingDetail ? ` (${incomingDetail})` : ''} goes into{' '}
            <strong>{targetSlot?.label ?? 'the slot'}</strong>
            {targetSlot ? ` · ${targetSlot.gridName}` : ''}.{' '}
            {poolName
              ? `It joins ${poolName} as ${roleValue === 'hot-spare' ? 'hot spare' : 'data'}.`
              : 'It has no pool.'}{' '}
            Install date: {installedOn === '' ? 'not recorded' : installedOn}.
            {occupantId ? (
              <>
                {' '}
                <strong className="mono">{occupant?.serial ?? 'The drive in it'}</strong>{' '}
                {occupantWord} first.
              </>
            ) : null}
          </Text>
        </>
      ) : null}
      {errorAlert}
    </StepFlow>
  );
}
