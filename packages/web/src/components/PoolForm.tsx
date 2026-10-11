import { useState } from 'react';
import { Alert, Button, Modal, Text, TextInput } from '@mantine/core';
import { createPoolInputSchema, updatePoolInputSchema } from '@sparrow/shared';
import { useCreatePool, useDeletePool, useUpdatePool } from '../api/poolMutations';
import type { PoolSummary } from '../api/schemas';
import { ApiError } from '../api/client';
import { ConfirmDialog } from './ConfirmDialog';

const orNull = (s: string) => (s.trim() === '' ? null : s.trim());

/** Create or edit a pool (R30): name, layout label and the optional expected drive count (R34). */
export function PoolForm({ pool, onClose }: { pool: PoolSummary | null; onClose: () => void }) {
  const create = useCreatePool();
  const update = useUpdatePool(pool?.id ?? '');
  const [name, setName] = useState(pool?.name ?? '');
  const [label, setLabel] = useState(pool?.layoutLabel ?? '');
  const [expected, setExpected] = useState(
    pool?.expectedMembers != null ? String(pool.expectedMembers) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const pending = create.isPending || update.isPending;

  const save = () => {
    const expectedText = expected.trim();
    const expectedMembers = expectedText === '' ? null : Number(expectedText);
    if (expectedMembers !== null && !Number.isInteger(expectedMembers)) {
      return setError('Expected drives must be a whole number.');
    }
    const body = { name, layoutLabel: orNull(label), expectedMembers };
    const onError = (e: Error) =>
      setError(e instanceof ApiError ? e.message : 'Could not save the pool.');
    const opts = { onSuccess: onClose, onError };
    setError(null);
    if (pool) {
      const parsed = updatePoolInputSchema.safeParse(body);
      if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the fields.');
      update.mutate(parsed.data, opts);
    } else {
      const parsed = createPoolInputSchema.safeParse(body);
      if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the fields.');
      create.mutate(parsed.data, opts);
    }
  };

  return (
    <Modal opened onClose={onClose} title={pool ? `Edit ${pool.name}` : 'New pool'} centered>
      <TextInput
        label="Name"
        required
        data-autofocus
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
      />
      <TextInput
        label="Layout label"
        description="Optional, for example raidz2 or mirror. Shown next to the pool name."
        mt="sm"
        value={label}
        onChange={(e) => setLabel(e.currentTarget.value)}
      />
      <TextInput
        label="Expected drives"
        description="Optional. Sparrow warns when the pool has fewer or more drives than this."
        mt="sm"
        inputMode="numeric"
        value={expected}
        onChange={(e) => setExpected(e.currentTarget.value)}
      />
      {error ? (
        <Alert color="red" mt="sm" role="alert">
          {error}
        </Alert>
      ) : null}
      <div className="dialog-actions">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button loading={pending} onClick={save}>
          {pool ? 'Save' : 'Create pool'}
        </Button>
      </div>
    </Modal>
  );
}

export function DeletePool({ pool, onClose }: { pool: PoolSummary; onClose: () => void }) {
  const del = useDeletePool(pool.id);
  return (
    <ConfirmDialog
      title={`Delete ${pool.name}`}
      confirmLabel="Delete pool"
      color="red"
      mutation={del}
      body={{}}
      onClose={onClose}
    >
      <Text>
        Delete the pool <strong>{pool.name}</strong>? This only works for a pool that has never had
        a member; once drives have belonged to it, its history is kept and it cannot be deleted.
      </Text>
    </ConfirmDialog>
  );
}
