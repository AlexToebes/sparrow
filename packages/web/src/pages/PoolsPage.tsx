import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Drawer, Skeleton, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import { useDrives, useLayout, usePools } from '../api/hooks';
import { poolDetailSchema, type PoolSummary } from '../api/schemas';
import { DeletePool, PoolForm } from '../components/PoolForm';
import { DriveDetail } from '../components/DriveDetail';
import { AlertTriangleIcon, CheckCircleIcon, PlusIcon } from '../components/icons';
import { formatBytes } from '../lib/format';
import { slotLabel } from '../lib/health';
import { sizeCheckText } from '../lib/poolSize';

/** R34: icon plus text, never color alone. Nothing is shown for a pool without an expected size. */
function SizeCheck({ pool }: { pool: PoolSummary }) {
  const text = sizeCheckText(pool.sizeCheck, pool.memberCount, pool.expectedMembers);
  if (text === null) return null;
  const ok = pool.sizeCheck === 'ok';
  return (
    <span className={`size-check ${ok ? 'size-ok' : 'size-warn'}`}>
      {ok ? <CheckCircleIcon size={15} /> : <AlertTriangleIcon size={15} />}
      <span>{text}</span>
    </span>
  );
}

function PoolCard({
  pool,
  onOpenDrive,
  onEdit,
  onDelete,
}: {
  pool: PoolSummary;
  onOpenDrive: (driveId: string) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const detail = useQuery({
    queryKey: ['pools', pool.id],
    queryFn: () => apiGet(`/api/pools/${pool.id}`, poolDetailSchema),
  });
  const members = detail.data?.members ?? [];

  return (
    <section className="card pool-card" aria-label={pool.name}>
      <div className="card-head">
        <h2 className="card-title">
          {pool.name}
          {pool.layoutLabel ? <span className="dim"> · {pool.layoutLabel}</span> : null}
        </h2>
        <div className="inline-form">
          <Button
            size="compact-md"
            variant="default"
            aria-label={`Edit ${pool.name}`}
            onClick={onEdit}
          >
            Edit
          </Button>
          <Button
            size="compact-md"
            variant="light"
            color="red"
            aria-label={`Delete ${pool.name}`}
            onClick={onDelete}
          >
            Delete
          </Button>
        </div>
      </div>
      <div className="pool-size">
        <SizeCheck pool={pool} />
        {pool.sizeCheck === null ? (
          <span className="dim">
            {pool.memberCount} {pool.memberCount === 1 ? 'member' : 'members'}
          </span>
        ) : null}
      </div>
      {detail.isPending ? <Skeleton height={48} mt="sm" /> : null}
      {detail.isError ? (
        <Text c="red" size="sm" mt="sm">
          Could not load the members.
        </Text>
      ) : null}
      {detail.isSuccess && members.length === 0 ? (
        <Text c="dimmed" size="sm" mt="sm">
          No drives in this pool.
        </Text>
      ) : null}
      {members.length > 0 ? (
        <ul className="pool-members" aria-label={`${pool.name} members`}>
          {members.map((m) => (
            <li key={m.membershipId}>
              <button type="button" className="pool-member" onClick={() => onOpenDrive(m.driveId)}>
                <span className="mono pool-member-serial">{m.serial}</span>
                <span className="dim">{formatBytes(m.capacityBytes) || '—'}</span>
                <span>{m.slotLabel ?? 'Not installed'}</span>
                <Badge variant="light" color={m.role === 'data' ? 'teal' : 'indigo'}>
                  {m.role === 'data' ? 'Data' : 'Hot spare'}
                </Badge>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Pools (R29, R30, R34, R76): a card per pool with its size check and current members. */
export function PoolsPage() {
  const phone = useMediaQuery('(max-width: 48em)') ?? false;
  const pools = usePools();
  const drives = useDrives();
  const layout = useLayout();
  const [form, setForm] = useState<PoolSummary | 'new' | null>(null);
  const [deleting, setDeleting] = useState<PoolSummary | null>(null);
  // The open drive lives in the URL (/pools?drive=ID), like on the Drives page.
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('drive');
  const setSelectedId = (id: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id === null) next.delete('drive');
        else next.set('drive', id);
        return next;
      },
      { replace: true },
    );

  const whereBySlot = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of layout.data?.enclosures ?? [])
      for (const g of e.grids) for (const s of g.slots) m.set(s.id, `${g.name}, ${slotLabel(s)}`);
    return m;
  }, [layout.data]);
  const selected = selectedId ? (drives.data?.find((d) => d.id === selectedId) ?? null) : null;

  return (
    <>
      <div className="page-title-row">
        <h1 className="page-title">Pools</h1>
        <div className="title-actions">
          <Button leftSection={<PlusIcon size={14} />} onClick={() => setForm('new')}>
            New pool
          </Button>
        </div>
      </div>
      <Text size="sm" c="dimmed" mb="md">
        Pools group drives (for example a ZFS pool). A drive joins a pool when you assign it to a
        slot, or later from its detail.
      </Text>
      {pools.isPending ? <Skeleton height={120} radius="lg" aria-label="Loading pools" /> : null}
      {pools.isError ? (
        <Alert color="red" title="Could not load the pools">
          {pools.error.message}{' '}
          <Button size="compact-sm" variant="light" onClick={() => pools.refetch()}>
            Retry
          </Button>
        </Alert>
      ) : null}
      {pools.isSuccess && pools.data.length === 0 ? <Text c="dimmed">No pools yet.</Text> : null}
      {pools.data?.map((p) => (
        <PoolCard
          key={p.id}
          pool={p}
          onOpenDrive={setSelectedId}
          onEdit={() => setForm(p)}
          onDelete={() => setDeleting(p)}
        />
      ))}

      <Drawer
        opened={selected !== null}
        onClose={() => setSelectedId(null)}
        position={phone ? 'bottom' : 'right'}
        size={phone ? '85%' : 460}
        title="Drive"
        closeButtonProps={{ 'aria-label': 'Close' }}
      >
        {selected ? (
          <DriveDetail
            drive={selected}
            where={selected.slotId ? (whereBySlot.get(selected.slotId) ?? null) : null}
          />
        ) : null}
      </Drawer>

      {form !== null ? (
        <PoolForm pool={form === 'new' ? null : form} onClose={() => setForm(null)} />
      ) : null}
      {deleting ? <DeletePool pool={deleting} onClose={() => setDeleting(null)} /> : null}
    </>
  );
}
