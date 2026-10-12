import { useState } from 'react';
import { Button, Drawer, Table, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { Link } from 'react-router';
import type { Drive } from '@sparrow/shared';
import { formatBytes } from '../lib/format';
import { AssignDialog } from './AssignDialog';
import { DriveDetail } from './DriveDetail';

/** Spares on the shelf (from C). Each row has an Assign action. */
export function SparesShelf({
  spares,
  retiredCount = 0,
}: {
  spares: Drive[];
  /** Shown as a link to the Drives page filtered to retired drives. */
  retiredCount?: number;
}) {
  const phone = useMediaQuery('(max-width: 48em)') ?? false;
  const [assigning, setAssigning] = useState<string | null>(null);
  // A row opens the drive's detail drawer, with its history; Assign stays its own button.
  const [viewing, setViewing] = useState<string | null>(null);
  const viewed = spares.find((d) => d.id === viewing) ?? null;
  return (
    <section className="card" aria-label="Spares shelf">
      <div className="card-head">
        <h2 className="card-title">Spares shelf</h2>
        <Text size="sm" c="dimmed">
          {spares.length} on hand
        </Text>
      </div>
      {spares.length === 0 ? (
        <Text c="dimmed" size="sm">
          No spares on the shelf.
        </Text>
      ) : phone ? (
        <ul className="shelf-cards" aria-label="Spares">
          {spares.map((d) => (
            <li key={d.id} className="shelf-card">
              <div className="shelf-card-top">
                <button
                  type="button"
                  className="link-button mono shelf-serial"
                  aria-label={`Details of ${d.serial}`}
                  onClick={() => setViewing(d.id)}
                >
                  {d.serial}
                </button>
                <span className="mono">{formatBytes(d.capacityBytes) || '—'}</span>
              </div>
              <div className="shelf-card-meta">
                {[d.model, d.condition].filter(Boolean).join(' · ') || 'No model or condition'}
              </div>
              <div className="shelf-card-bottom">
                <span className="shelf-card-where">{d.storageLocation ?? 'On the shelf'}</span>
                <Button
                  size="compact-md"
                  variant="light"
                  aria-label={`Assign ${d.serial}`}
                  onClick={() => setAssigning(d.id)}
                >
                  Assign
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <Table.ScrollContainer minWidth={560}>
          <Table verticalSpacing="xs" horizontalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Serial</Table.Th>
                <Table.Th>Model</Table.Th>
                <Table.Th>Capacity</Table.Th>
                <Table.Th>Condition</Table.Th>
                <Table.Th>Location</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {spares.map((d) => (
                <Table.Tr key={d.id} className="drive-row" onClick={() => setViewing(d.id)}>
                  <Table.Td className="mono">
                    <button
                      type="button"
                      className="link-button mono"
                      aria-label={`Details of ${d.serial}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setViewing(d.id);
                      }}
                    >
                      {d.serial}
                    </button>
                  </Table.Td>
                  <Table.Td>{d.model ?? '—'}</Table.Td>
                  <Table.Td className="mono">{formatBytes(d.capacityBytes) || '—'}</Table.Td>
                  <Table.Td>{d.condition ?? '—'}</Table.Td>
                  <Table.Td>{d.storageLocation ?? '—'}</Table.Td>
                  <Table.Td>
                    <Button
                      size="compact-sm"
                      variant="light"
                      aria-label={`Assign ${d.serial}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setAssigning(d.id);
                      }}
                    >
                      Assign
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      <Text size="sm" mt="sm">
        <Link to="/drives?status=retired">Retired drives ({retiredCount}) →</Link>
      </Text>
      <Drawer
        opened={viewed !== null}
        onClose={() => setViewing(null)}
        position={phone ? 'bottom' : 'right'}
        size={phone ? '85%' : 460}
        title="Spare drive"
        closeButtonProps={{ 'aria-label': 'Close' }}
      >
        {viewed ? <DriveDetail drive={viewed} /> : null}
      </Drawer>
      {assigning ? <AssignDialog driveId={assigning} onClose={() => setAssigning(null)} /> : null}
    </section>
  );
}
