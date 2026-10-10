import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Skeleton, Text } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { gridSchema, type LayoutGrid, type SlotStatus } from '@sparrow/shared';
import {
  queryKeys,
  useDrivePools,
  useDrives,
  useInbox,
  useLayout,
  useSlotStatus,
} from '../api/hooks';
import { apiSend } from '../api/client';
import { BayGrid } from '../components/BayGrid';
import { FlipIcon, BoxIcon, InboxIcon } from '../components/icons';
import { AssignDialog } from '../components/AssignDialog';
import { SlotDetail } from '../components/SlotDetail';
import { SlotTile, StateIcon, poolColor } from '../components/SlotTile';
import { SparesShelf } from '../components/SparesShelf';
import { displayDimensions } from '../lib/grid';
import { buildSlotView, type SlotView } from '../lib/health';
import { formatRelative } from '../lib/format';
import { collectProblems, summarySentence } from '../lib/summary';
import { useNow } from '../lib/useNow';

function FlipButton({ grid }: { grid: LayoutGrid }) {
  const qc = useQueryClient();
  const flip = useMutation({
    mutationFn: () =>
      apiSend(
        'PATCH',
        `/api/grids/${grid.id}`,
        { orientation: grid.orientation === 'landscape' ? 'portrait' : 'landscape' },
        gridSchema,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.layout }),
  });
  const next = displayDimensions(
    grid.rows,
    grid.columns,
    grid.orientation === 'landscape' ? 'portrait' : 'landscape',
  );
  return (
    <Button
      variant="subtle"
      color="gray"
      size="compact-xs"
      leftSection={<FlipIcon size={14} />}
      loading={flip.isPending}
      onClick={() => flip.mutate()}
    >
      Flip to {next.columns} × {next.rows}
    </Button>
  );
}

export function LayoutPage() {
  const layout = useLayout();
  const drives = useDrives();
  const spares = useDrives('spare');
  const status = useSlotStatus();
  const inbox = useInbox();
  const drivePools = useDrivePools();
  const now = useNow();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [assignSlotId, setAssignSlotId] = useState<string | null>(null);

  const statusBySlot = useMemo(() => {
    const m = new Map<string, SlotStatus>();
    for (const s of status.data?.slots ?? []) m.set(s.slotId, s);
    return m;
  }, [status.data]);
  const driveById = useMemo(
    () => new Map((drives.data ?? []).map((d) => [d.id, d])),
    [drives.data],
  );

  const views = useMemo(() => {
    const m = new Map<string, SlotView>();
    for (const e of layout.data?.enclosures ?? [])
      for (const g of e.grids)
        for (const s of g.slots)
          m.set(
            s.id,
            buildSlotView(
              s,
              s.driveId ? (driveById.get(s.driveId) ?? null) : null,
              statusBySlot.get(s.id) ?? null,
              now,
            ),
          );
    return m;
  }, [layout.data, driveById, statusBySlot, now]);

  if (layout.isPending) return <Skeleton height={260} radius="lg" aria-label="Loading layout" />;
  if (layout.isError) {
    return (
      <Alert color="red" title="Could not load the layout">
        {layout.error.message}{' '}
        <Button size="compact-sm" variant="light" onClick={() => layout.refetch()}>
          Retry
        </Button>
      </Alert>
    );
  }

  const allViews = [...views.values()];
  const providerStale = status.data?.providerStale ?? false;
  const problems = collectProblems(
    allViews,
    providerStale,
    (v) => `stale ${formatRelative(v.status?.lastReportedAt, now).replace(' ago', '')}`,
  );
  const occupied = allViews.filter((v) => v.state !== 'empty');
  const healthy = occupied.filter((v) => v.state === 'ok').length;
  const hasHealthData = occupied.some((v) => v.health !== 'unknown');
  const inboxCount = inbox.data?.count ?? 0;
  const spareCount = spares.data?.length ?? 0;
  const selected = selectedId ? (views.get(selectedId) ?? null) : null;
  const selectedGrid = selectedId
    ? (layout.data.enclosures
        .flatMap((e) => e.grids)
        .find((g) => g.slots.some((s) => s.id === selectedId)) ?? null)
    : null;

  const noGrids = layout.data.enclosures.every((e) => e.grids.length === 0);

  return (
    <>
      <h2 className="summary">{summarySentence(problems.length, hasHealthData)}</h2>
      {inboxCount > 0 ? (
        <Text c="dimmed" className="summary-sub">
          {inboxCount} new {inboxCount === 1 ? 'drive is' : 'drives are'} waiting in Inbox.
        </Text>
      ) : null}
      <div className="chips" aria-label="Problems and counts">
        {hasHealthData ? (
          <span className="chip" data-kind="ok">
            <strong>{healthy}</strong> healthy
          </span>
        ) : null}
        {problems.map((p) => (
          <button
            key={p.slotId}
            type="button"
            className="chip chip-button"
            data-kind={p.kind}
            onClick={() => setSelectedId(p.slotId)}
          >
            <StateIcon state={p.kind} size={14} />
            {p.text}
          </button>
        ))}
        {inboxCount > 0 ? (
          <Link to="/inbox" className="chip chip-button" data-kind="info">
            <InboxIcon size={14} />
            {inboxCount} in Inbox
          </Link>
        ) : null}
        <span className="chip" data-kind="info">
          <BoxIcon size={14} />
          <strong>{spareCount}</strong> {spareCount === 1 ? 'spare' : 'spares'} on hand
        </span>
      </div>

      {noGrids ? (
        <Alert title="No grids yet" color="indigo">
          Add an enclosure and grid in Settings to see your bays here.
        </Alert>
      ) : null}

      {layout.data.enclosures.map((enc) => (
        <div key={enc.id} className="enclosure">
          {layout.data.enclosures.length > 1 ? (
            <h2 className="enclosure-name">{enc.name}</h2>
          ) : null}
          <div className="grids">
            {enc.grids.map((grid) => {
              const dims = displayDimensions(grid.rows, grid.columns, grid.orientation);
              const filled = grid.slots.filter((s) => s.driveId !== null).length;
              const poolsHere = new Map<string, ReturnType<typeof drivePools.get>>();
              for (const s of grid.slots) {
                const p = s.driveId ? drivePools.get(s.driveId) : undefined;
                if (p) poolsHere.set(p.poolId, p);
              }
              return (
                <section key={grid.id} className="card" aria-label={grid.name}>
                  <div className="card-head">
                    <h2 className="card-title">{grid.name}</h2>
                    <div className="card-meta">
                      <Text size="sm" c="dimmed">
                        {dims.columns} × {dims.rows} · {filled} of {grid.slots.length} occupied
                      </Text>
                      <FlipButton grid={grid} />
                    </div>
                  </div>
                  <BayGrid
                    rows={grid.rows}
                    columns={grid.columns}
                    orientation={grid.orientation}
                    slots={grid.slots}
                    label={grid.name}
                    renderSlot={(slot) => {
                      const view = views.get(slot.id);
                      if (!view) return null;
                      return (
                        <SlotTile
                          view={view}
                          pool={slot.driveId ? drivePools.get(slot.driveId) : undefined}
                          selected={selectedId === slot.id}
                          onSelect={(id) =>
                            view.state === 'empty' ? setAssignSlotId(id) : setSelectedId(id)
                          }
                        />
                      );
                    }}
                  />
                  {poolsHere.size > 0 ? (
                    <div className="legend" aria-label="Pools in this grid">
                      {[...poolsHere.values()].map((p) =>
                        p ? (
                          <Badge
                            key={p.poolId}
                            variant="light"
                            color={poolColor(p.colorIndex)}
                            size="sm"
                          >
                            {p.poolName}
                            {p.layoutLabel ? ` · ${p.layoutLabel}` : ''}
                          </Badge>
                        ) : null,
                      )}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        </div>
      ))}

      {assignSlotId ? (
        <AssignDialog slotId={assignSlotId} onClose={() => setAssignSlotId(null)} />
      ) : null}

      <SparesShelf spares={spares.data ?? []} />

      <SlotDetail
        view={selected}
        gridName={selectedGrid?.name ?? null}
        onClose={() => setSelectedId(null)}
      />
    </>
  );
}
