import { useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  SegmentedControl,
  Skeleton,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { Drawer } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import type { Drive, DriveStatus } from '@sparrow/shared';
import { useDrives, useLayout } from '../api/hooks';
import { DriveDetail } from '../components/DriveDetail';
import { DriveFormDialog } from '../components/DriveFormDialog';
import { PlusIcon } from '../components/icons';
import { formatBytes } from '../lib/format';
import { slotLabel } from '../lib/health';

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

export function DrivesPage() {
  const phone = useMediaQuery('(max-width: 48em)') ?? false;
  const drives = useDrives();
  const layout = useLayout();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

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
  const shown = all
    .filter((d) => filter === 'all' || d.status === filter)
    .filter((d) => matchesSearch(d, search))
    .sort((a, b) => a.serial.localeCompare(b.serial));
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
        <Button leftSection={<PlusIcon size={14} />} onClick={() => setAdding(true)}>
          Add drive
        </Button>
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
            ? 'No drives yet. Add one, or resolve the Inbox once a provider reports drives.'
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
                  <Badge variant="light" color={STATUS_COLOR[d.status]}>
                    {STATUS_WORD[d.status]}
                  </Badge>
                </span>
                <Text size="sm" c="dimmed">
                  {[d.model, d.driveType, formatBytes(d.capacityBytes)].filter(Boolean).join(' · ')}
                </Text>
                <Text size="sm">{whereOf(d)}</Text>
              </button>
            ))}
          </div>
        ) : (
          <section className="card" aria-label="Drives">
            <Table.ScrollContainer minWidth={560}>
              <Table verticalSpacing="xs" horizontalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Serial</Table.Th>
                    <Table.Th>Model</Table.Th>
                    <Table.Th>Capacity</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th>Where</Table.Th>
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
                        </Badge>
                      </Table.Td>
                      <Table.Td>{whereOf(d)}</Table.Td>
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
