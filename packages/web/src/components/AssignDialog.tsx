import { useMemo, useState } from 'react';
import { Alert, Button, Modal, Radio, Select, Text, Textarea, TextInput } from '@mantine/core';
import type { Drive, MembershipRole, OccupantResolution } from '@sparrow/shared';
import { ApiError } from '../api/client';
import { occupantFromError, useAssignDrive, useAssignmentDefaults } from '../api/driveMutations';
import { useDrives, useLayout, usePools } from '../api/hooks';
import { slotLabel } from '../lib/health';
import {
  RetireFields,
  driveLabel,
  retireValuesError,
  todayLocal,
  type RetireValues,
} from './RetireFields';

interface AssignDialogProps {
  onClose: () => void;
  /** Fixed target slot (from an empty slot's "+ Assign"), or leave out to pick one. */
  slotId?: string | null;
  /** Fixed drive (from a spare's detail), or leave out to pick a spare. */
  driveId?: string | null;
}

type Choice = 'spare' | 'retire' | 'rma';
const NO_POOL = '__none__';

/**
 * Assign a spare to a slot (R8, R35). Retired drives are never offered. When the slot is occupied the
 * dialog moves to a resolution step for the occupant (R37, R62) and submits it with the assignment.
 * Mount it only while open: its state starts fresh each time.
 */
export function AssignDialog({
  onClose,
  slotId: fixedSlot = null,
  driveId: fixedDrive = null,
}: AssignDialogProps) {
  const layout = useLayout();
  const spares = useDrives('spare');
  const allDrives = useDrives();
  const pools = usePools();
  const assign = useAssignDrive();

  const [slotId, setSlotId] = useState<string | null>(fixedSlot);
  const [driveId, setDriveId] = useState<string | null>(fixedDrive);
  const [poolPick, setPoolPick] = useState<string | undefined>(undefined);
  const [rolePick, setRolePick] = useState<MembershipRole | undefined>(undefined);
  const [step, setStep] = useState<'form' | 'occupant'>('form');
  const [error, setError] = useState<string | null>(null);
  const [apiOccupantId, setApiOccupantId] = useState<string | null>(null);

  const defaults = useAssignmentDefaults(slotId);

  const slots = useMemo(() => {
    const multi = (layout.data?.enclosures.length ?? 0) > 1;
    return (layout.data?.enclosures ?? []).flatMap((enc) =>
      enc.grids.map((g) => ({
        group: multi ? `${enc.name} / ${g.name}` : g.name,
        gridName: g.name,
        slots: [...g.slots].sort((a, b) => a.position - b.position),
      })),
    );
  }, [layout.data]);
  const slotById = useMemo(() => {
    const m = new Map<string, { gridName: string; label: string; driveId: string | null }>();
    for (const g of slots)
      for (const s of g.slots)
        m.set(s.id, { gridName: g.gridName, label: slotLabel(s), driveId: s.driveId });
    return m;
  }, [slots]);
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

  // Pool and role: the user's pick, else the slot's defaults (R35).
  const defaultPool = defaults.data?.poolId ?? null;
  const poolValue = poolPick === undefined ? defaultPool : poolPick === NO_POOL ? null : poolPick;
  const roleValue: MembershipRole = rolePick ?? defaults.data?.role ?? 'data';

  const [choice, setChoice] = useState<Choice>('spare');
  const [retireValues, setRetireValues] = useState<RetireValues>(() => ({
    reason: 'replaced',
    date: todayLocal(),
    replacedByDriveId: fixedDrive,
    note: '',
  }));
  const [rmaDate, setRmaDate] = useState(todayLocal);
  const [rmaNote, setRmaNote] = useState('');

  const submit = (resolution?: OccupantResolution) => {
    if (!slotId || !driveId) return;
    setError(null);
    assign.mutate(
      {
        slotId,
        driveId,
        poolId: poolValue,
        ...(poolValue !== null ? { role: roleValue } : {}),
        ...(resolution ? { occupant: resolution } : {}),
      },
      {
        onSuccess: onClose,
        onError: (e) => {
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
      },
    );
  };

  const onAssignClick = () => {
    if (!slotId || !driveId) {
      setError('Choose both a slot and a drive.');
      return;
    }
    if (occupantId) {
      setRetireValues((v) => ({ ...v, replacedByDriveId: driveId }));
      setStep('occupant');
      return;
    }
    submit();
  };

  const submitResolution = () => {
    const note = (s: string) => (s.trim() === '' ? null : s.trim());
    if (choice === 'spare') return submit({ action: 'spare' });
    if (choice === 'rma') return submit({ action: 'rma', date: rmaDate, note: note(rmaNote) });
    const problem = retireValuesError(retireValues);
    if (problem) {
      setError(problem);
      return;
    }
    submit({
      action: 'retire',
      reason: retireValues.reason!,
      date: retireValues.date,
      note: note(retireValues.note),
      replacedByDriveId: retireValues.replacedByDriveId,
    });
  };

  const slotData = slots.map((g) => ({
    group: g.group,
    items: g.slots.map((s) => {
      const occ = s.driveId ? driveById.get(s.driveId) : null;
      return {
        value: s.id,
        label: s.driveId
          ? `${slotLabel(s)} (occupied${occ ? ` by ${occ.serial}` : ''})`
          : slotLabel(s),
      };
    }),
  }));

  const title =
    step === 'occupant' ? `${targetSlot?.label ?? 'Slot'} is occupied` : 'Assign to a slot';

  return (
    <Modal opened onClose={onClose} title={title} centered>
      {step === 'form' ? (
        <>
          {fixedDrive === null ? (
            <Select
              label="Drive"
              description="Spares only"
              placeholder="Choose a spare"
              required
              searchable
              data={(spares.data ?? []).map((d) => ({ value: d.id, label: driveLabel(d) }))}
              value={driveId}
              onChange={setDriveId}
              nothingFoundMessage="No spares"
              comboboxProps={{ withinPortal: false }}
            />
          ) : (
            <Text>
              Assign <strong className="mono">{incoming?.serial ?? '…'}</strong>
              {incoming ? ` (${driveLabel(incoming).split(' · ').slice(1).join(' · ')})` : ''}
            </Text>
          )}
          {fixedSlot === null ? (
            <Select
              label="Slot"
              placeholder="Choose a slot"
              required
              mt="sm"
              data={slotData}
              value={slotId}
              onChange={(v) => {
                setSlotId(v);
                setPoolPick(undefined);
                setRolePick(undefined);
              }}
              comboboxProps={{ withinPortal: false }}
            />
          ) : (
            <Text mt="xs">
              Into{' '}
              <strong>{targetSlot ? `${targetSlot.gridName}, ${targetSlot.label}` : '…'}</strong>
            </Text>
          )}
          {slotId ? (
            <>
              <Select
                label="Pool"
                description={
                  defaults.data?.previousDriveId
                    ? 'Prefilled from the slot’s previous drive'
                    : undefined
                }
                mt="sm"
                data={[
                  { value: NO_POOL, label: 'No pool' },
                  ...(pools.data ?? []).map((p) => ({
                    value: p.id,
                    label: p.layoutLabel ? `${p.name} · ${p.layoutLabel}` : p.name,
                  })),
                ]}
                value={poolValue ?? NO_POOL}
                onChange={(v) => setPoolPick(v ?? NO_POOL)}
                allowDeselect={false}
                disabled={defaults.isPending}
                comboboxProps={{ withinPortal: false }}
              />
              {poolValue !== null ? (
                <Select
                  label="Role"
                  mt="sm"
                  data={[
                    { value: 'data', label: 'Data' },
                    { value: 'hot-spare', label: 'Hot spare' },
                  ]}
                  value={roleValue}
                  onChange={(v) => setRolePick((v as MembershipRole | null) ?? undefined)}
                  allowDeselect={false}
                  comboboxProps={{ withinPortal: false }}
                />
              ) : null}
            </>
          ) : null}
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
              loading={assign.isPending}
              disabled={!slotId || !driveId || (slotId !== null && defaults.isPending)}
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
            <strong className="mono">{incoming?.serial ?? 'the new drive'}</strong> goes in?
          </Text>
          <Radio.Group value={choice} onChange={(v) => setChoice(v as Choice)} mt="sm">
            <Radio value="spare" label="Back to spares" mb="xs" />
            <Radio value="retire" label="Retire it (replaced)" mb="xs" />
            <Radio value="rma" label="Send for RMA" mb="xs" />
          </Radio.Group>
          {choice === 'retire' && occupant ? (
            <RetireFields
              idPrefix="occ-retire"
              drive={occupant}
              candidates={(allDrives.data ?? []).filter((d) => d.id !== occupant.id)}
              values={retireValues}
              onChange={setRetireValues}
            />
          ) : null}
          {choice === 'rma' ? (
            <>
              <TextInput
                label="Date"
                type="date"
                value={rmaDate}
                onChange={(e) => setRmaDate(e.currentTarget.value)}
                mt="sm"
              />
              <Textarea
                label="Note"
                autosize
                minRows={2}
                value={rmaNote}
                onChange={(e) => setRmaNote(e.currentTarget.value)}
                mt="sm"
              />
            </>
          ) : null}
          {error ? (
            <Alert color="red" mt="sm">
              {error}
            </Alert>
          ) : null}
          <div className="dialog-actions">
            <Button variant="default" onClick={() => setStep('form')}>
              Back
            </Button>
            <Button
              color={choice === 'spare' ? 'indigo' : 'red'}
              loading={assign.isPending}
              onClick={submitResolution}
            >
              {choice === 'spare'
                ? 'Move to spares and assign'
                : choice === 'retire'
                  ? 'Retire it and assign'
                  : 'Send for RMA and assign'}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
