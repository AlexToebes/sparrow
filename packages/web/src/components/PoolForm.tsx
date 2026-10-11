import { useState } from 'react';
import { Alert, Button, Modal, Skeleton, Text, TextInput } from '@mantine/core';
import { createPoolInputSchema, updatePoolInputSchema } from '@sparrow/shared';
import { usePools } from '../api/hooks';
import { useCreatePool, useDeletePool, useUpdatePool } from '../api/poolMutations';
import type { PoolSummary } from '../api/schemas';
import { ApiError } from '../api/client';
import { ConfirmDialog } from './ConfirmDialog';

const orNull = (s: string) => (s.trim() === '' ? null : s.trim());

function PoolForm({ pool, onClose }: { pool: PoolSummary | null; onClose: () => void }) {
  const create = useCreatePool();
  const update = useUpdatePool(pool?.id ?? '');
  const [name, setName] = useState(pool?.name ?? '');
  const [label, setLabel] = useState(pool?.layoutLabel ?? '');
  const [error, setError] = useState<string | null>(null);
  const pending = create.isPending || update.isPending;

  const save = () => {
    const body = { name, layoutLabel: orNull(label) };
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

function DeletePool({ pool, onClose }: { pool: PoolSummary; onClose: () => void }) {
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

/** Pool management (R29, R30): list with member counts, create, rename and label, delete when allowed. */
export function PoolsSection() {
  const pools = usePools();
  const [form, setForm] = useState<PoolSummary | 'new' | null>(null);
  const [deleting, setDeleting] = useState<PoolSummary | null>(null);

  return (
    <section className="card" aria-label="Pools">
      <div className="card-head">
        <h2 className="card-title">Pools</h2>
        <Button size="compact-md" onClick={() => setForm('new')}>
          New pool
        </Button>
      </div>
      <Text size="sm" c="dimmed" mb="sm">
        Pools group drives (for example a ZFS pool). A drive joins a pool when you assign it to a
        slot, or later from its detail.
      </Text>
      {pools.isPending ? <Skeleton height={60} /> : null}
      {pools.isError ? <Text c="red">Could not load the pools.</Text> : null}
      {pools.data?.length === 0 ? <Text c="dimmed">No pools yet.</Text> : null}
      {pools.data?.map((p) => (
        <div key={p.id} className="pool-row">
          <div>
            <strong>{p.name}</strong>
            {p.layoutLabel ? <span className="dim"> · {p.layoutLabel}</span> : null}
            <div className="dim">
              {p.memberCount} {p.memberCount === 1 ? 'member' : 'members'}
            </div>
          </div>
          <div className="inline-form">
            <Button
              size="compact-md"
              variant="default"
              aria-label={`Edit ${p.name}`}
              onClick={() => setForm(p)}
            >
              Edit
            </Button>
            <Button
              size="compact-md"
              variant="light"
              color="red"
              aria-label={`Delete ${p.name}`}
              onClick={() => setDeleting(p)}
            >
              Delete
            </Button>
          </div>
        </div>
      ))}
      {form !== null ? (
        <PoolForm pool={form === 'new' ? null : form} onClose={() => setForm(null)} />
      ) : null}
      {deleting ? <DeletePool pool={deleting} onClose={() => setDeleting(null)} /> : null}
    </section>
  );
}
