import { useState } from 'react';
import { Radio, Select, Text, Textarea } from '@mantine/core';
import type { Drive, MembershipRole } from '@sparrow/shared';
import { useAssignmentDefaults, type OccupantInput } from '../api/driveMutations';
import { usePools } from '../api/hooks';
import { NOT_RECORDED_HINT, OptionalDateField } from './OptionalDateField';
import {
  RETIREMENT_DATE_HINT,
  RetireFields,
  removedOnError,
  retirementDateError,
  retireValuesError,
  todayLocal,
  type RetireValues,
} from './RetireFields';

export { NOT_RECORDED_HINT, OptionalDateField };

const NO_POOL = '__none__';

/** Pool and role for a slot: the user's pick, else the slot's current or last occupant (R35). */
export function usePoolRole(slotId: string | null) {
  const defaults = useAssignmentDefaults(slotId);
  const [poolPick, setPoolPick] = useState<string | undefined>(undefined);
  const [rolePick, setRolePick] = useState<MembershipRole | undefined>(undefined);
  const poolValue =
    poolPick === undefined
      ? (defaults.data?.poolId ?? null)
      : poolPick === NO_POOL
        ? null
        : poolPick;
  const roleValue: MembershipRole = rolePick ?? defaults.data?.role ?? 'data';
  return {
    poolValue,
    roleValue,
    pending: defaults.isPending,
    hasPrevious: Boolean(defaults.data?.previousDriveId),
    setPool: (v: string | null) => setPoolPick(v ?? NO_POOL),
    setRole: (v: MembershipRole | undefined) => setRolePick(v),
    reset: () => {
      setPoolPick(undefined);
      setRolePick(undefined);
    },
  };
}

export type PoolRole = ReturnType<typeof usePoolRole>;

export function PoolRoleFields({ state }: { state: PoolRole }) {
  const pools = usePools();
  return (
    <>
      <Select
        label="Pool"
        description={state.hasPrevious ? 'Prefilled from the slot’s previous drive' : undefined}
        mt="sm"
        data={[
          { value: NO_POOL, label: 'No pool' },
          ...(pools.data ?? []).map((p) => ({
            value: p.id,
            label: p.layoutLabel ? `${p.name} · ${p.layoutLabel}` : p.name,
          })),
        ]}
        value={state.poolValue ?? NO_POOL}
        onChange={state.setPool}
        allowDeselect={false}
        disabled={state.pending}
      />
      {state.poolValue !== null ? (
        <Select
          label="Role"
          mt="sm"
          data={[
            { value: 'data', label: 'Data' },
            { value: 'hot-spare', label: 'Hot spare' },
          ]}
          value={state.roleValue}
          onChange={(v) => state.setRole((v as MembershipRole | null) ?? undefined)}
          allowDeselect={false}
        />
      ) : null}
    </>
  );
}

export type OutcomeChoice = 'spare' | 'retire' | 'rma';

/** What happens to the drive that is leaving a slot (R27, R37, R62, R69). */
export interface OutcomeState {
  choice: OutcomeChoice;
  retire: RetireValues;
  rmaDate: string;
  rmaNote: string;
  /** R69: when it came out; empty = not recorded. */
  removedOn: string;
}

export const initialOutcome = (replacedByDriveId: string | null): OutcomeState => ({
  choice: 'spare',
  retire: { reason: 'replaced', date: todayLocal(), replacedByDriveId, note: '' },
  rmaDate: todayLocal(),
  rmaNote: '',
  removedOn: todayLocal(),
});

/** The occupant resolution to send, or the message to show. */
export function outcomeToResolution(
  s: OutcomeState,
): { resolution: OccupantInput; error?: undefined } | { resolution?: undefined; error: string } {
  const note = (v: string) => (v.trim() === '' ? null : v.trim());
  if (s.choice === 'spare') {
    const problem = removedOnError(s.removedOn);
    if (problem) return { error: problem };
    return { resolution: { action: 'spare', removedOn: s.removedOn === '' ? null : s.removedOn } };
  }
  if (s.choice === 'rma') {
    const rmaProblem = retirementDateError(s.rmaDate);
    if (rmaProblem) return { error: rmaProblem };
    return {
      resolution: {
        action: 'rma',
        date: s.rmaDate === '' ? null : s.rmaDate,
        note: note(s.rmaNote),
      },
    };
  }
  const problem = retireValuesError(s.retire);
  if (problem) return { error: problem };
  return {
    resolution: {
      action: 'retire',
      reason: s.retire.reason!,
      date: s.retire.date === '' ? null : s.retire.date,
      note: note(s.retire.note),
      replacedByDriveId: s.retire.replacedByDriveId,
    },
  };
}

interface OutcomeFieldsProps {
  state: OutcomeState;
  onChange: (state: OutcomeState) => void;
  /** The drive leaving the slot. */
  outgoing: Drive;
  /** Every drive, for the "replaced by" choices. */
  drives: Drive[];
  idPrefix: string;
  /** Wording of the retire option. */
  retireLabel?: string;
}

/** The three outcomes for the outgoing drive with their fields. Shared by the occupied-slot step and Replace with…. */
export function OutcomeFields({
  state,
  onChange,
  outgoing,
  drives,
  idPrefix,
  retireLabel = 'Retire it (replaced)',
}: OutcomeFieldsProps) {
  const set = (patch: Partial<OutcomeState>) => onChange({ ...state, ...patch });
  return (
    <>
      <Radio.Group
        value={state.choice}
        onChange={(v) => set({ choice: v as OutcomeChoice })}
        mt="sm"
        aria-label="What happens to the outgoing drive"
      >
        <Radio value="spare" label="Back to spares" mb="xs" />
        <Radio value="retire" label={retireLabel} mb="xs" />
        <Radio value="rma" label="Send for RMA" mb="xs" />
      </Radio.Group>
      {state.choice === 'spare' ? (
        <OptionalDateField
          label="Removed on (optional)"
          description={NOT_RECORDED_HINT}
          value={state.removedOn}
          onChange={(v) => set({ removedOn: v })}
        />
      ) : null}
      {state.choice === 'retire' ? (
        <RetireFields
          idPrefix={idPrefix}
          drive={outgoing}
          candidates={drives.filter((d) => d.id !== outgoing.id)}
          values={state.retire}
          onChange={(retire) => set({ retire })}
        />
      ) : null}
      {state.choice === 'rma' ? (
        <>
          <OptionalDateField
            label="RMA date (optional)"
            description={RETIREMENT_DATE_HINT}
            value={state.rmaDate}
            onChange={(rmaDate) => set({ rmaDate })}
            error={retirementDateError(state.rmaDate)}
          />
          <Textarea
            label="Note"
            autosize
            minRows={2}
            value={state.rmaNote}
            onChange={(e) => set({ rmaNote: e.currentTarget.value })}
            mt="sm"
          />
        </>
      ) : null}
      {state.choice === 'spare' ? null : (
        <Text size="xs" c="dimmed" mt="xs">
          It leaves the slot and its pool membership ends. Its history is kept.
        </Text>
      )}
    </>
  );
}
