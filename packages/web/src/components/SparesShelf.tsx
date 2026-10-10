import { useState } from 'react';
import { Button, Table, Text } from '@mantine/core';
import type { Drive } from '@sparrow/shared';
import { formatBytes } from '../lib/format';
import { AssignDialog } from './AssignDialog';

/** Spares on the shelf (from C). Each row has an Assign action. */
export function SparesShelf({ spares }: { spares: Drive[] }) {
  const [assigning, setAssigning] = useState<string | null>(null);
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
      ) : (
        <Table.ScrollContainer minWidth={420}>
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
                <Table.Tr key={d.id}>
                  <Table.Td className="mono">{d.serial}</Table.Td>
                  <Table.Td>{d.model ?? '—'}</Table.Td>
                  <Table.Td className="mono">{formatBytes(d.capacityBytes) || '—'}</Table.Td>
                  <Table.Td>{d.condition ?? '—'}</Table.Td>
                  <Table.Td>{d.storageLocation ?? '—'}</Table.Td>
                  <Table.Td>
                    <Button
                      size="compact-sm"
                      variant="light"
                      aria-label={`Assign ${d.serial}`}
                      onClick={() => setAssigning(d.id)}
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
      {assigning ? <AssignDialog driveId={assigning} onClose={() => setAssigning(null)} /> : null}
    </section>
  );
}
