import { useState } from 'react';
import { Badge, Button, Checkbox, Select, Table, Text, TextInput } from '@mantine/core';
import { RETIREMENT_REASONS, type RetiredCandidate, type RetirementReason } from '@sparrow/shared';
import { useImportRetired } from '../api/inboxMutations';
import { formatBytes } from '../lib/format';
import { HEALTH_WORD } from '../lib/health';
import { ConfirmDialog } from './ConfirmDialog';
import { stateColor } from './DriveDetail';
import { StateIcon } from './SlotTile';

const REASON_LABEL: Record<RetirementReason, string> = {
  failed: 'Failed',
  replaced: 'Replaced',
  other: 'Other',
};
const REASON_DATA = RETIREMENT_REASONS.map((r) => ({ value: r, label: REASON_LABEL[r] }));
const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

interface Row {
  selected: boolean;
  reason: RetirementReason | null;
  date: string;
}

/**
 * R63: drives the provider reports as decommissioned, offered as retired records. Every selected row
 * needs its own reason (no default); the health shown is a hint only and is never applied.
 */
export function ImportRetiredPanel({ candidates }: { candidates: RetiredCandidate[] }) {
  const importer = useImportRetired();
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [bulk, setBulk] = useState<RetirementReason | null>(null);
  const [confirming, setConfirming] = useState(false);

  const rowOf = (c: RetiredCandidate): Row =>
    rows[c.observationKey] ?? { selected: false, reason: null, date: c.retirementDate };
  const patch = (c: RetiredCandidate, p: Partial<Row>) =>
    setRows((r) => ({ ...r, [c.observationKey]: { ...rowOf(c), ...p } }));

  const selected = candidates.filter((c) => rowOf(c).selected);
  const ready =
    selected.length > 0 && selected.every((c) => rowOf(c).reason && validDate(rowOf(c).date));
  const allSelected = selected.length === candidates.length;
  const missingReasons = selected.filter((c) => !rowOf(c).reason).length;

  const items = selected.map((c) => ({
    observationKey: c.observationKey,
    reason: rowOf(c).reason!,
    date: rowOf(c).date,
  }));

  return (
    <section aria-label="Import retired drives">
      <Text size="sm" c="dimmed" mb="sm">
        The provider still reports these drives as decommissioned. Importing creates a retired
        record for each, so their history is kept. Choose a reason for every drive you import; the
        reported health is only a hint and is never applied. You can skip this entirely.
      </Text>
      <div className="bulk-bar">
        <Select
          aria-label="Reason for selected drives"
          placeholder="Reason for selected"
          data={REASON_DATA}
          value={bulk}
          onChange={(v) => setBulk(v as RetirementReason | null)}
          allowDeselect={false}
        />
        <Button
          variant="default"
          disabled={!bulk || selected.length === 0}
          onClick={() => bulk && selected.forEach((c) => patch(c, { reason: bulk }))}
        >
          Apply reason to selected
        </Button>
      </div>
      <Table.ScrollContainer minWidth={760}>
        <Table verticalSpacing="xs" horizontalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>
                <Checkbox
                  aria-label="Select all"
                  checked={allSelected && candidates.length > 0}
                  indeterminate={selected.length > 0 && !allSelected}
                  onChange={(e) =>
                    setRows((r) =>
                      Object.fromEntries(
                        candidates.map((c) => [
                          c.observationKey,
                          {
                            ...(r[c.observationKey] ?? rowOf(c)),
                            selected: e.currentTarget.checked,
                          },
                        ]),
                      ),
                    )
                  }
                />
              </Table.Th>
              <Table.Th>Serial</Table.Th>
              <Table.Th>Drive</Table.Th>
              <Table.Th>Last known health (hint)</Table.Th>
              <Table.Th>Reason</Table.Th>
              <Table.Th>Date</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {candidates.map((c) => {
              const row = rowOf(c);
              return (
                <Table.Tr key={c.observationKey}>
                  <Table.Td>
                    <Checkbox
                      aria-label={`Select ${c.serial}`}
                      checked={row.selected}
                      onChange={(e) => patch(c, { selected: e.currentTarget.checked })}
                    />
                  </Table.Td>
                  <Table.Td className="mono">{c.serial}</Table.Td>
                  <Table.Td>
                    {[c.model, c.driveType, formatBytes(c.capacityBytes)]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </Table.Td>
                  <Table.Td>
                    <Badge variant="outline" color={stateColor(c.healthHint)}>
                      <span className="badge-icon">
                        <StateIcon state={c.healthHint} size={12} />
                      </span>{' '}
                      {HEALTH_WORD[c.healthHint]}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Select
                      aria-label={`Reason for ${c.serial}`}
                      placeholder="Choose a reason"
                      data={REASON_DATA}
                      value={row.reason}
                      onChange={(v) => patch(c, { reason: v as RetirementReason | null })}
                      allowDeselect={false}
                    />
                  </Table.Td>
                  <Table.Td>
                    <TextInput
                      aria-label={`Date for ${c.serial}`}
                      type="date"
                      value={row.date}
                      onChange={(e) => patch(c, { date: e.currentTarget.value })}
                    />
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      <div className="dialog-actions">
        {selected.length > 0 && missingReasons > 0 ? (
          <Text size="sm" c="dimmed" role="status">
            {missingReasons} selected {missingReasons === 1 ? 'drive needs' : 'drives need'} a
            reason.
          </Text>
        ) : null}
        <Button disabled={!ready} onClick={() => setConfirming(true)}>
          Import {selected.length || ''} retired {selected.length === 1 ? 'drive' : 'drives'}
        </Button>
      </div>
      {confirming ? (
        <ConfirmDialog
          title="Import retired drives"
          confirmLabel={`Import ${items.length}`}
          mutation={importer}
          body={{ items }}
          onClose={() => setConfirming(false)}
        >
          <Text>
            Create {items.length} retired {items.length === 1 ? 'record' : 'records'}? Each gets the
            reason and date you chose. This is all or nothing, and they can be reinstated later.
          </Text>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
