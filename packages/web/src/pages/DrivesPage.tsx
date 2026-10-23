import { useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  ActionIcon,
  Select,
  SegmentedControl,
  Skeleton,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { Drawer } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { Link, useSearchParams } from 'react-router';
import type { Drive, DriveStatus, SlotStatus } from '@sparrow/shared';
import { useDrives, useInbox, useLayout, useSlotStatus, useSuggestionSummary } from '../api/hooks';
import { DriveDetail } from '../components/DriveDetail';
import { DriveFormDialog } from '../components/DriveFormDialog';
import { ArrowDownIcon, ArrowUpIcon, InboxIcon, PlusIcon, UpdateIcon } from '../components/icons';
import {
  DEFAULT_SORT,
  nextSort,
  parseSort,
  slotRanks,
  sortDrives,
  type SortKey,
  type SortState,
} from '../lib/driveSort';
import { formatBytes } from '../lib/format';
import { HEALTH_WORD, slotLabel } from '../lib/health';
import { StateIcon } from '../components/SlotTile';

type Filter = DriveStatus | 'all';

const STATUS_COLOR: Record<DriveStatus, string> = {
  spare: 'indigo',
  installed: 'teal',
  retired: 'gray',
};
const STATUS_WORD: Record<DriveStatus, string> = {
  spare: 'Spare',
  installed: 'Installed',
  retired: 'Retired',
};

/** Case-insensitive match on serial or model (the normalized serial ignores separators). */
export function matchesSearch(d: Drive, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    d.serial.toLowerCase().includes(q) ||
    (squash(q) !== '' && d.serialNormalized.includes(squash(q))) ||
    (d.model ?? '').toLowerCase().includes(q)
  );
}

const SORT_LABEL: Record<SortKey, string> = {
  serial: 'Serial',
  model: 'Model',
  capacity: 'Capacity',
  status: 'Status',
  where: 'Where',
  health: 'Health',
};

/** A column header that sorts: icon plus aria-sort show the direction, never color alone. */
function SortHeader({
  col,
  sort,
  onSort,
}: {
  col: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
}) {
  const active = sort.key === col;
  return (
    <Table.Th aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="sort-button" onClick={() => onSort(col)}>
        {SORT_LABEL[col]}
        {active ? (
          sort.dir === 'asc' ? (
            <ArrowUpIcon size={14} />
          ) : (
            <ArrowDownIcon size={14} />
          )
        ) : null}
      </button>
    </Table.Th>
  );
}

/** R72: shown on rows whose record could be filled in from the provider (icon plus text). */
function UpdatesFlag() {
  return (
    <span className="update-flag" title="The provider reports details this record doesn't have">
      <UpdateIcon size={14} />
      Updates
    </span>
  );
}

/**
 * A compact health indicator for an installed drive: icon plus word, never color alone (AGENTS 8).
 * Stale data keeps its last known health but is labelled stale (R18, R47). Nothing for a drive
 * without a slot status (spares and retired drives have none).
 */
export function HealthMark({ status }: { status: SlotStatus | undefined }) {
  if (!status) return <span className="dim">—</span>;
  if (status.flag) {
    return (
      <span className="health-mark" data-state="missing">
        <StateIcon state="missing" size={14} /> Missing
      </span>
    );
  }
  if (status.lastReportedAt === null) {
    return (
      <span className="health-mark" data-state="unknown">
        <StateIcon state="unknown" size={14} /> Not reported
      </span>
    );
  }
  if (status.stale) {
    return (
      <span className="health-mark" data-state="stale">
        <StateIcon state="stale" size={14} /> Stale, last {HEALTH_WORD[status.health].toLowerCase()}
      </span>
    );
  }
  return (
    <span className="health-mark" data-state={status.health}>
      <StateIcon state={status.health} size={14} /> {HEALTH_WORD[status.health]}
    </span>
  );
}

export function DrivesPage() {
  const phone = useMediaQuery('(max-width: 48em)') ?? false;
  const drives = useDrives();
  const slotStatus = useSlotStatus();
  const layout = useLayout();
  const inboxCount = useInbox().data?.count ?? 0;
  const statusBySlot = useMemo(
    () => new Map((slotStatus.data?.slots ?? []).map((st) => [st.slotId, st])),
    [slotStatus.data],
  );
  const healthOf = (d: Drive) => (d.slotId ? statusBySlot.get(d.slotId) : undefined);
  const suggestions = useSuggestionSummary().data?.byDriveId ?? {};
  const hasUpdates = (d: Drive) => (suggestions[d.id]?.fill ?? 0) > 0;
  // The status filter lives in the URL (/drives?status=retired) so it can be linked to.
  const [params, setParams] = useSearchParams();
  const statusParam = params.get('status');
  const filter: Filter =
    statusParam === 'spare' || statusParam === 'installed' || statusParam === 'retired'
      ? statusParam
      : 'all';
  const setFilter = (f: Filter) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (f === 'all') next.delete('status');
        else next.set('status', f);
        return next;
      },
      { replace: true },
    );
  // The sort lives in the URL too (?sort=capacity&dir=desc); the default (serial, ascending) is omitted.
  const sort = parseSort(params.get('sort'), params.get('dir'));
  const setSort = (s: SortState) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (s.key === DEFAULT_SORT.key && s.dir === DEFAULT_SORT.dir) {
          next.delete('sort');
          next.delete('dir');
        } else {
          next.set('sort', s.key);
          next.set('dir', s.dir);
        }
        return next;
      },
      { replace: true },
    );
  const onSort = (key: SortKey) => setSort(nextSort(sort, key));
  const ranks = useMemo(() => slotRanks(layout.data), [layout.data]);
  const [search, setSearch] = useState('');
  // The open drive lives in the URL too (/drives?drive=ID), so the Inbox can link to a drive.
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
  // /drives?add=1 opens the add dialog (the setup wizard's last step links here).
  const [adding, setAdding] = useState(params.get('add') === '1');

  const whereBySlot = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of layout.data?.enclosures ?? [])
      for (const g of e.grids) for (const s of g.slots) m.set(s.id, `${g.name}, ${slotLabel(s)}`);
    return m;
  }, [layout.data]);

  const all = drives.data ?? [];
  const counts = {
    all: all.length,
    spare: all.filter((d) => d.status === 'spare').length,
    installed: all.filter((d) => d.status === 'installed').length,
    retired: all.filter((d) => d.status === 'retired').length,
  };
  const shown = sortDrives(
    all.filter((d) => (filter === 'all' || d.status === filter) && matchesSearch(d, search)),
    sort,
    { ranks, statusBySlot },
  );
  const selected = selectedId ? (all.find((d) => d.id === selectedId) ?? null) : null;
  const whereOf = (d: Drive) =>
    d.status === 'installed' && d.slotId
      ? (whereBySlot.get(d.slotId) ?? 'In a slot')
      : d.status === 'spare'
        ? (d.storageLocation ?? 'On the shelf')
        : '—';

  return (
    <>
      <div className="page-title-row">
        <h2 className="page-title">Drives</h2>
        <div className="title-actions">
          {/* R71: the inbox lives here; loud when something waits, quiet otherwise. */}
          <Button
            component={Link}
            to="/drives/discovered"
            variant={inboxCount > 0 ? 'filled' : 'default'}
            leftSection={<InboxIcon size={16} />}
            rightSection={
              inboxCount > 0 ? (
                <Badge
                  size="sm"
                  circle
                  variant="white"
                  color="indigo"
                  aria-label={`${inboxCount} discovered`}
                >
                  {inboxCount}
                </Badge>
              ) : null
            }
          >
            Discovered
          </Button>
          <Button
            variant={inboxCount > 0 ? 'default' : 'filled'}
            leftSection={<PlusIcon size={14} />}
            onClick={() => setAdding(true)}
          >
            Add drive
          </Button>
        </div>
      </div>
      <div className="toolbar">
        <SegmentedControl
          aria-label="Filter by status"
          value={filter}
          onChange={(v) => setFilter(v as Filter)}
          data={[
            { value: 'all', label: `All ${counts.all}` },
            { value: 'spare', label: `Spare ${counts.spare}` },
            { value: 'installed', label: `Installed ${counts.installed}` },
            { value: 'retired', label: `Retired ${counts.retired}` },
          ]}
        />
        <TextInput
          className="toolbar-grow"
          aria-label="Search drives"
          placeholder="Search serial or model"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
        {phone ? (
          <div className="sort-row">
            <Select
              className="toolbar-grow"
              aria-label="Sort by"
              allowDeselect={false}
              data={(Object.keys(SORT_LABEL) as SortKey[]).map((k) => ({
                value: k,
                label: `Sort: ${SORT_LABEL[k]}`,
              }))}
              value={sort.key}
              onChange={(v) => v && setSort({ key: v as SortKey, dir: sort.dir })}
            />
            <ActionIcon
              variant="default"
              size="lg"
              aria-label={
                sort.dir === 'asc' ? 'Ascending, tap to reverse' : 'Descending, tap to reverse'
              }
              onClick={() => setSort({ key: sort.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' })}
            >
              {sort.dir === 'asc' ? <ArrowUpIcon /> : <ArrowDownIcon />}
            </ActionIcon>
          </div>
        ) : null}
      </div>

      {drives.isPending ? <Skeleton height={200} radius="lg" aria-label="Loading drives" /> : null}
      {drives.isError ? (
        <Alert color="red" title="Could not load the drives">
          {drives.error.message}{' '}
          <Button size="compact-sm" variant="light" onClick={() => drives.refetch()}>
            Retry
          </Button>
        </Alert>
      ) : null}
      {drives.isSuccess && shown.length === 0 ? (
        <Text c="dimmed">
          {all.length === 0
            ? 'No drives yet. Add one, or resolve the discovered drives once a provider reports drives.'
            : 'No drives match.'}
        </Text>
      ) : null}

      {drives.isSuccess && shown.length > 0 ? (
        phone ? (
          <div className="drive-cards" aria-label="Drives">
            {shown.map((d) => (
              <button
                key={d.id}
                type="button"
                className="drive-card"
                onClick={() => setSelectedId(d.id)}
              >
                <span className="drive-card-top">
                  <span className="mono" style={{ fontWeight: 600 }}>
                    {d.serial}
                  </span>
                  <span className="drive-card-flags">
                    {hasUpdates(d) ? <UpdatesFlag /> : null}
                    <Badge variant="light" color={STATUS_COLOR[d.status]}>
                      {STATUS_WORD[d.status]}
                    </Badge>
                  </span>
                </span>
                <Text size="sm" c="dimmed">
                  {[d.model, d.driveType, formatBytes(d.capacityBytes)].filter(Boolean).join(' · ')}
                </Text>
                <span className="drive-card-bottom">
                  <Text component="span" size="sm">
                    {whereOf(d)}
                  </Text>
                  {d.status === 'installed' ? <HealthMark status={healthOf(d)} /> : null}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <section className="card" aria-label="Drives">
            <Table.ScrollContainer minWidth={680}>
              <Table verticalSpacing="xs" horizontalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    {(Object.keys(SORT_LABEL) as SortKey[]).map((c) => (
                      <SortHeader key={c} col={c} sort={sort} onSort={onSort} />
                    ))}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {shown.map((d) => (
                    <Table.Tr key={d.id} className="drive-row" onClick={() => setSelectedId(d.id)}>
                      <Table.Td className="mono">
                        <button
                          type="button"
                          className="link-button mono"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedId(d.id);
                          }}
                        >
                          {d.serial}
                        </button>
                      </Table.Td>
                      <Table.Td>{d.model ?? '—'}</Table.Td>
                      <Table.Td className="mono">{formatBytes(d.capacityBytes) || '—'}</Table.Td>
                      <Table.Td>
                        <Badge variant="light" color={STATUS_COLOR[d.status]}>
                          {STATUS_WORD[d.status]}
                        </Badge>{' '}
                        {hasUpdates(d) ? <UpdatesFlag /> : null}
                      </Table.Td>
                      <Table.Td>{whereOf(d)}</Table.Td>
                      <Table.Td>
                        {d.status === 'installed' ? <HealthMark status={healthOf(d)} /> : '—'}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </section>
        )
      ) : null}

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

      {adding ? (
        <DriveFormDialog onClose={() => setAdding(false)} onSaved={(d) => setSelectedId(d.id)} />
      ) : null}
    </>
  );
}
