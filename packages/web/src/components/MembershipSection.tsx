import { useState } from 'react';
import { Alert, Button, Select, Text } from '@mantine/core';
import type { Drive, MembershipRole } from '@sparrow/shared';
import { ApiError } from '../api/client';
import { usePools } from '../api/hooks';
import { useChangeMembership, useJoinPool, useLeavePool } from '../api/poolMutations';
import { ConfirmDialog } from './ConfirmDialog';

const ROLE_DATA = [
  { value: 'data', label: 'Data' },
  { value: 'hot-spare', label: 'Hot spare' },
];
const ROLE_WORD: Record<MembershipRole, string> = { data: 'data', 'hot-spare': 'hot spare' };

/**
 * Pool membership of an installed drive (R29, R36): join, change pool, change role, leave. The pool and
 * role are properties of the drive's installation; what happened before is in the History section.
 * Joining needs an installed drive; the server refuses otherwise.
 */
export function MembershipSection({ drive }: { drive: Drive }) {
  const pools = usePools();
  const join = useJoinPool(drive.id);
  const change = useChangeMembership(drive.id);
  const leave = useLeavePool(drive.id);
  const [poolPick, setPoolPick] = useState<string | null>(null);
  const [rolePick, setRolePick] = useState<MembershipRole | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open =
    drive.poolId !== null && drive.poolRole !== null
      ? { poolId: drive.poolId, role: drive.poolRole }
      : null;
  const poolName = (id: string) => pools.data?.find((p) => p.id === id)?.name ?? id;
  const poolId = poolPick ?? open?.poolId ?? null;
  const role = rolePick ?? open?.role ?? 'data';
  const changed = open !== null && (poolId !== open.poolId || role !== open.role);

  const done = () => {
    setPoolPick(null);
    setRolePick(null);
    setError(null);
  };
  const onError = (e: Error) =>
    setError(e instanceof ApiError ? e.message : 'Could not change the membership.');

  const save = () => {
    if (!poolId) return;
    setError(null);
    if (!open) join.mutate({ poolId, role }, { onSuccess: done, onError });
    else
      change.mutate(
        {
          ...(poolId !== open.poolId ? { poolId } : {}),
          ...(role !== open.role ? { role } : {}),
        },
        { onSuccess: done, onError },
      );
  };

  return (
    <section aria-label="Pool membership">
      <h3 className="section-title">Pool</h3>
      <Text size="sm" c="dimmed" mb="xs">
        {open ? `In ${poolName(open.poolId)} as ${ROLE_WORD[open.role]}.` : 'Not in a pool.'}
      </Text>
      <div className="inline-form">
        <Select
          aria-label="Pool"
          placeholder="Choose a pool"
          data={(pools.data ?? []).map((p) => ({
            value: p.id,
            label: p.layoutLabel ? `${p.name} · ${p.layoutLabel}` : p.name,
          }))}
          value={poolId}
          onChange={setPoolPick}
          allowDeselect={false}
        />
        <Select
          aria-label="Role"
          data={ROLE_DATA}
          value={role}
          onChange={(v) => setRolePick(v as MembershipRole | null)}
          allowDeselect={false}
        />
        <Button
          size="compact-md"
          disabled={!poolId || (open !== null && !changed)}
          loading={join.isPending || change.isPending}
          onClick={save}
        >
          {open ? 'Save change' : 'Join pool'}
        </Button>
        {open ? (
          <Button size="compact-md" variant="light" color="red" onClick={() => setLeaving(true)}>
            Leave pool
          </Button>
        ) : null}
      </div>
      {error ? (
        <Alert color="red" mt="sm" role="alert">
          {error}
        </Alert>
      ) : null}
      {leaving ? (
        <ConfirmDialog
          title="Leave pool"
          confirmLabel="Leave pool"
          mutation={leave}
          body={{}}
          onClose={() => setLeaving(false)}
        >
          <Text>
            Take <strong className="mono">{drive.serial}</strong> out of{' '}
            {open ? poolName(open.poolId) : 'its pool'}? The drive stays in its slot; the history
            keeps the change.
          </Text>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
