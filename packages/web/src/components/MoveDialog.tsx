import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Alert, Button, Select, Text, Textarea } from '@mantine/core';
import {
  RETIREMENT_REASONS,
  type Drive,
  type MoveDriveInput,
  type RetirementReason,
} from '@sparrow/shared';
import { ApiError } from '../api/client';
import { occupantFromError, useMoveDrive } from '../api/driveMutations';
import { useDrives, useLayout, usePools } from '../api/hooks';
import { formatBytes } from '../lib/format';
import { slotLabel } from '../lib/health';
import { NOT_RECORDED_HINT, OptionalDateField, PoolRoleFields, usePoolRole } from './AssignFields';
import { CheckIcon } from './icons';
import { todayLocal } from './RetireFields';
import { SlotPicker } from './SlotPicker';
import { SparePicker } from './SparePicker';
import { StepFlow, type StepDef } from './StepFlow';

export type MoveDestinationChoice = 'spares' | 'slot' | 'retire' | 'rma';
type Fill = 'empty' | 'spare';
type OccupantChoice = 'swap' | 'spare' | 'retire' | 'rma';
type Step = 'where' | 'bay' | 'occupant' | 'fill' | 'details' | 'confirm';

const STEP_TITLE: Record<Step, string> = {
  where: 'Where does this drive go?',
  bay: 'Which bay?',
  occupant: 'What happens to the drive in that bay?',
  fill: 'What goes into this bay?',
  details: 'Details',
  confirm: 'Confirm',
};
const REASON_LABEL: Record<RetirementReason, string> = {
  failed: 'Failed',
  replaced: 'Replaced',
  other: 'Other',
};

const capacityOf = (d: Drive) => formatBytes(d.capacityBytes) || 'capacity unknown';

/** The date is optional (empty = not recorded); if given it must be a real date, not later than today (local). */
function moveDateError(value: string): string | null {
  if (value === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    return 'Enter a valid date.';
  }
  return value > todayLocal() ? 'The date cannot be in the future.' : null;
}

interface CardOption<V extends string> {
  value: V;
  title: string;
  description?: string;
}

/** Answers as radio cards (the same look as the spare cards): one tap picks, arrow keys move. */
function ChoiceCards<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V | null;
  options: CardOption<V>[];
  onChange: (value: V) => void;
}) {
  const refs = useRef(new Map<V, HTMLButtonElement>());
  const tabbable = options.some((o) => o.value === value) ? value : options[0]?.value;
  const move = (e: KeyboardEvent, index: number) => {
    const delta = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
    if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(e.key)) return;
    e.preventDefault();
    const target = options[index + delta];
    if (!target) return;
    onChange(target.value);
    refs.current.get(target.value)?.focus();
  };
  return (
    <div className="spare-list choice-list" role="radiogroup" aria-label={label}>
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={o.value === tabbable ? 0 : -1}
            ref={(el) => {
              if (el) refs.current.set(o.value, el);
              else refs.current.delete(o.value);
            }}
            className="spare-card"
            data-selected={selected ? 'true' : undefined}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => move(e, i)}
          >
            <span className="spare-card-top">
              <strong>{o.title}</strong>
              {selected ? (
                <span className="pick-check">
                  <CheckIcon size={12} />
                </span>
              ) : null}
            </span>
            {o.description ? <span className="spare-card-meta">{o.description}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * R73: "Move" on an installed drive, replacing Replace and Remove to spares. One decision per step
 * (R70): where it goes (spares, another bay, retire, RMA) together with the one optional date for
 * everything (R68, R69), the bay on the grids, what happens to the
 * drive already in that bay (R37), what goes into the vacated bay (a spare, with sizes compared,
 * R60), pool and role of an incoming spare (R35), then a
 * summary and ONE POST /api/drives/:id/move. A move between bays keeps the pool membership.
 * `initialDestination` preselects the answer to the first question (the Retire button). Mount only
 * while open.
 */
export function MoveDialog({
  drive,
  where,
  initialDestination = null,
  onClose,
}: {
  drive: Drive;
  where: string | null;
  initialDestination?: MoveDestinationChoice | null;
  onClose: () => void;
}) {
  const sourceSlotId = drive.slotId!;
  const layout = useLayout();
  const spares = useDrives('spare');
  const allDrives = useDrives();
  const pools = usePools();
  const move = useMoveDrive(drive.id);
  const poolRole = usePoolRole(sourceSlotId);

  const [dest, setDest] = useState<MoveDestinationChoice | null>(initialDestination);
  const [reason, setReason] = useState<RetirementReason | null>(null);
  const [note, setNote] = useState('');
  const [targetId, setTargetId] = useState<string | null>(null);
  const [apiOccupantId, setApiOccupantId] = useState<string | null>(null);
  const [occupantChoice, setOccupantChoice] = useState<OccupantChoice>('spare');
  const [occupantReason, setOccupantReason] = useState<RetirementReason | null>(null);
  const [occupantNote, setOccupantNote] = useState('');
  const [fill, setFill] = useState<Fill | null>(null);
  const [spareId, setSpareId] = useState<string | null>(null);
  // R68, R69, R60: ONE optional date for every part of the move; empty = not recorded.
  const [date, setDate] = useState(todayLocal);
  const [current, setCurrent] = useState<Step>('where');
  const [error, setError] = useState<string | null>(null);

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

  const target = targetId ? (slotById.get(targetId) ?? null) : null;
  const targetWhere = target ? `${target.gridName}, ${target.label}` : 'the bay';
  const occupantId = dest === 'slot' ? (target?.driveId ?? apiOccupantId) : null;
  const occupant = occupantId ? (driveById.get(occupantId) ?? null) : null;
  // R73: swapping puts the bay's drive into this drive's bay, so nothing else fills it.
  const swapping = dest === 'slot' && occupantId !== null && occupantChoice === 'swap';
  const spare =
    fill === 'spare' && !swapping ? (spares.data?.find((d) => d.id === spareId) ?? null) : null;
  const here = where ?? 'its bay';
  const poolName = poolRole.poolValue
    ? (pools.data?.find((p) => p.id === poolRole.poolValue)?.name ?? 'a pool')
    : null;
  const roleWord = poolRole.roleValue === 'hot-spare' ? 'hot spare' : 'data';
  const trimmed = (v: string) => (v.trim() === '' ? null : v.trim());

  // Only the steps that apply: the count in the header follows.
  const steps: StepDef<Step>[] = (
    [
      'where',
      ...(dest === 'slot' ? ['bay' as const] : []),
      ...(dest === 'slot' && occupantId ? ['occupant' as const] : []),
      ...(swapping ? [] : ['fill' as const]),
      ...(fill === 'spare' && !swapping ? ['details' as const] : []),
      'confirm',
    ] satisfies Step[]
  ).map((key) => ({ key, title: STEP_TITLE[key] }));
  const index = Math.max(
    0,
    steps.findIndex((s) => s.key === current),
  );
  const goTo = (key: Step) => {
    setError(null);
    setCurrent(key);
  };

  const valid =
    current === 'where'
      ? dest !== null && (dest !== 'retire' || reason !== null) && moveDateError(date) === null
      : current === 'bay'
        ? targetId !== null
        : current === 'occupant'
          ? occupantChoice !== 'retire' || occupantReason !== null
          : current === 'fill'
            ? fill === 'empty' || (fill === 'spare' && spare !== null)
            : current === 'details'
              ? !poolRole.pending
              : true;

  const next = () => {
    if (current === 'where' && dest === 'retire' && reason === null) {
      return setError('Choose a reason.');
    }
    const to = steps[index + 1];
    if (to) goTo(to.key);
  };
  const back = () => {
    const to = steps[index - 1];
    if (to) goTo(to.key);
  };

  const buildInput = (withOccupant: boolean): MoveDriveInput => {
    let destination: MoveDriveInput['destination'];
    if (dest === 'slot') {
      destination = {
        kind: 'slot',
        slotId: targetId!,
        ...(withOccupant && occupantId
          ? {
              occupant:
                occupantChoice === 'swap'
                  ? { action: 'swap' as const }
                  : occupantChoice === 'spare'
                    ? { action: 'spare' as const }
                    : occupantChoice === 'rma'
                      ? { action: 'rma' as const, note: trimmed(occupantNote) }
                      : {
                          action: 'retire' as const,
                          reason: occupantReason!,
                          note: trimmed(occupantNote),
                        },
            }
          : {}),
      };
    } else if (dest === 'retire') {
      destination = { kind: 'retire', reason: reason!, note: trimmed(note) };
    } else if (dest === 'rma') {
      destination = { kind: 'rma', note: trimmed(note) };
    } else {
      destination = { kind: 'spares' };
    }
    return {
      destination,
      ...(spare
        ? {
            replacement: {
              driveId: spare.id,
              poolId: poolRole.poolValue,
              ...(poolRole.poolValue !== null ? { role: poolRole.roleValue } : {}),
            },
          }
        : {}),
      date: date === '' ? null : date,
    };
  };

  const confirm = () => {
    const problem = moveDateError(date);
    if (problem) {
      goTo('where');
      return setError(problem);
    }
    setError(null);
    move.mutate(buildInput(true), {
      onSuccess: onClose,
      onError: (e) => {
        if (e instanceof ApiError && e.status === 409) {
          const occ = occupantFromError(e.details);
          if (occ && dest === 'slot' && !occupantId) {
            // The bay filled up since the layout loaded: ask what to do with its drive (R37).
            setApiOccupantId(occ.driveId);
            return goTo('occupant');
          }
        }
        setError(e instanceof ApiError ? e.message : 'Could not move the drive.');
      },
    });
  };

  const destructive =
    dest === 'retire' ||
    dest === 'rma' ||
    (occupantId !== null && occupantChoice !== 'spare' && occupantChoice !== 'swap');
  const last = current === 'confirm';
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
        <Button color={destructive ? 'red' : 'indigo'} loading={move.isPending} onClick={confirm}>
          Confirm move
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

  const driveWord = (
    <>
      <strong className="mono">{drive.serial}</strong> ({capacityOf(drive)})
    </>
  );

  // Confirm: one paragraph.
  const occupantWord =
    occupantChoice === 'spare'
      ? 'moved to the spares'
      : occupantChoice === 'rma'
        ? 'sent for RMA'
        : `retired (${occupantReason ? REASON_LABEL[occupantReason].toLowerCase() : '…'})`;
  const what: ReactNode = swapping ? (
    <>
      <strong>
        {here} ⇄ {targetWhere}
      </strong>
      : {driveWord} and <strong className="mono">{occupant?.serial ?? 'the other drive'}</strong>{' '}
      {occupant ? `(${capacityOf(occupant)}) ` : ''}swap places. Both keep their pool membership.
    </>
  ) : dest === 'slot' ? (
    <>
      {driveWord} moves from {here} to <strong>{targetWhere}</strong> and keeps its pool membership.
    </>
  ) : dest === 'retire' ? (
    <>
      {driveWord} leaves {here} and is retired ({reason ? REASON_LABEL[reason].toLowerCase() : '…'}
      ); its pool membership ends.
    </>
  ) : dest === 'rma' ? (
    <>
      {driveWord} leaves {here} and is sent for RMA; its pool membership ends.
    </>
  ) : (
    <>
      {driveWord} leaves {here} and goes back to the spares shelf; its pool membership ends.
    </>
  );

  return (
    <StepFlow
      totalKnown={!(dest === 'slot' && fill === null && !swapping)}
      title={`Move ${drive.serial}`}
      steps={steps}
      current={current}
      onClose={onClose}
      footer={footer}
    >
      {current === 'where' ? (
        <>
          <Text mb="xs">
            Where does {driveWord} go from {here}?
          </Text>
          <ChoiceCards<MoveDestinationChoice>
            label="Where the drive goes"
            value={dest}
            onChange={(v) => {
              setDest(v);
              setError(null);
            }}
            options={[
              { value: 'spares', title: 'Spares shelf', description: 'Still works' },
              { value: 'slot', title: 'Another bay', description: 'Keeps its pool membership' },
              { value: 'retire', title: 'Retire', description: 'Broken or done' },
              { value: 'rma', title: 'Send for RMA' },
            ]}
          />
          {dest === 'retire' ? (
            <Select
              label="Reason"
              required
              mt="sm"
              placeholder="Why is it being retired?"
              data={RETIREMENT_REASONS.map((r) => ({ value: r, label: REASON_LABEL[r] }))}
              value={reason}
              onChange={(v) => setReason(v as RetirementReason | null)}
              allowDeselect={false}
            />
          ) : null}
          {dest === 'retire' || dest === 'rma' ? (
            <Textarea
              label="Note (optional)"
              autosize
              minRows={2}
              mt="sm"
              value={note}
              onChange={(e) => setNote(e.currentTarget.value)}
            />
          ) : null}
          <OptionalDateField
            label="When? (optional)"
            description={NOT_RECORDED_HINT}
            value={date}
            onChange={(v) => {
              setDate(v);
              setError(null);
            }}
            error={moveDateError(date)}
          />
          {errorAlert}
        </>
      ) : null}

      {current === 'bay' ? (
        <>
          <Text mb="xs">
            Tap the bay {driveWord} moves to. {here} is where it is now.
          </Text>
          <SlotPicker
            value={targetId}
            label="Destination bay"
            disabledSlotIds={[sourceSlotId]}
            onChange={(id) => {
              setTargetId(id);
              setApiOccupantId(null);
            }}
          />
        </>
      ) : null}

      {current === 'occupant' ? (
        <>
          <Text mb="xs">
            <strong className="mono">{occupant?.serial ?? 'Another drive'}</strong>
            {occupant ? ` (${capacityOf(occupant)})` : ''} is in {target ? targetWhere : 'that bay'}
            . What should happen to it before <strong className="mono">{drive.serial}</strong> moves
            in?
          </Text>
          <ChoiceCards<OccupantChoice>
            label="What happens to the drive in that bay"
            value={occupantChoice}
            onChange={(v) => {
              setOccupantChoice(v);
              setError(null);
            }}
            options={[
              {
                value: 'swap',
                title: `Swap — put ${occupant?.serial ?? 'it'} into ${here}`,
                description: 'Both drives keep their pool membership',
              },
              { value: 'spare', title: 'Back to spares', description: 'Still works' },
              { value: 'retire', title: 'Retire', description: 'Broken or done' },
              { value: 'rma', title: 'Send for RMA' },
            ]}
          />
          {occupantChoice === 'retire' ? (
            <Select
              label="Reason"
              required
              mt="sm"
              placeholder="Why is it being retired?"
              data={RETIREMENT_REASONS.map((r) => ({ value: r, label: REASON_LABEL[r] }))}
              value={occupantReason}
              onChange={(v) => setOccupantReason(v as RetirementReason | null)}
              allowDeselect={false}
            />
          ) : null}
          {occupantChoice === 'retire' || occupantChoice === 'rma' ? (
            <>
              <Textarea
                label="Note (optional)"
                autosize
                minRows={2}
                mt="sm"
                value={occupantNote}
                onChange={(e) => setOccupantNote(e.currentTarget.value)}
              />
              <Text size="xs" c="dimmed" mt="xs">
                It leaves the bay and its pool membership ends. Its history is kept.
              </Text>
            </>
          ) : null}
        </>
      ) : null}

      {current === 'fill' ? (
        <>
          <Text mb="xs">
            {driveWord} {dest === 'slot' ? `moves out of ${here}` : `leaves ${here}`}. What goes
            into {here}?
          </Text>
          <ChoiceCards<Fill>
            label="What goes into this bay"
            value={fill}
            onChange={setFill}
            options={[
              { value: 'empty', title: 'Leave it empty' },
              { value: 'spare', title: 'A spare', description: 'Chosen from the spares shelf' },
            ]}
          />
          {fill === 'spare' ? (
            <>
              <Text fw={500} size="sm" mt="md" mb={6}>
                Which spare goes in?
              </Text>
              <SparePicker
                spares={spares.data ?? []}
                value={spareId}
                onChange={setSpareId}
                loading={spares.isPending}
                outgoing={drive}
              />
              {spare ? (
                <Text size="sm" mt="xs">
                  Out: <span className="mono">{drive.serial}</span> ({capacityOf(drive)}) · In:{' '}
                  <span className="mono">{spare.serial}</span> ({capacityOf(spare)})
                </Text>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}

      {current === 'details' && spare ? (
        <>
          <Text>
            Pool and role for <strong className="mono">{spare.serial}</strong> in {here}.
            {dest === 'slot' ? ` ${drive.serial} keeps its own pool membership.` : ''}
          </Text>
          <PoolRoleFields state={poolRole} />
        </>
      ) : null}

      {current === 'confirm' ? (
        <>
          <Text>
            {what}
            {occupantId && !swapping ? (
              <>
                {' '}
                <strong className="mono">{occupant?.serial ?? 'The drive in it'}</strong> is{' '}
                {occupantWord} first.
              </>
            ) : null}{' '}
            {swapping ? null : spare ? (
              <>
                <strong className="mono">{spare.serial}</strong> ({capacityOf(spare)}) goes into{' '}
                {here}
                {poolName ? `, joining ${poolName} as ${roleWord}` : ' with no pool'}.
              </>
            ) : (
              <>{here} is left empty.</>
            )}{' '}
            {date === '' ? (
              'No date is recorded.'
            ) : (
              <>
                Date: <span style={{ whiteSpace: 'nowrap' }}>{date}</span>.
              </>
            )}
          </Text>
          {errorAlert}
        </>
      ) : null}
    </StepFlow>
  );
}
