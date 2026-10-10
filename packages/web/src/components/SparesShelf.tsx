import { Table, Text } from '@mantine/core';
import type { Drive } from '@sparrow/shared';
import { formatBytes } from '../lib/format';

/** Spares on the shelf (from C). Read-only for now: assigning arrives in Step 12. */
export function SparesShelf({ spares }: { spares: Drive[] }) {
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
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </section>
  );
}
