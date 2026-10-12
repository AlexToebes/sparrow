import { useState } from 'react';
import { useMediaQuery } from '@mantine/hooks';
import { Badge, Button, Checkbox, Select, Table, Text, TextInput } from '@mantine/core';
import { RETIREMENT_REASONS, type RetiredCandidate, type RetirementReason } from '@sparrow/shared';
import { useImportRetired } from '../api/inboxMutations';
import { formatBytes } from '../lib/format';
import { HEALTH_WORD } from '../lib/health';
import { ConfirmDialog } from './ConfirmDialog';
import { stateColor } from './DriveDetail';
import { StateIcon } from './SlotTile';
import { retirementDateError, todayLocal } from './RetireFields';

const REASON_LABEL: Record<RetirementReason, string> = {
  failed: 'Failed',
  replaced: 'Replaced',
  other: 'Other',
};
const REASON_DATA = RETIREMENT_REASONS.map((r) => ({ value: r, label: REASON_LABEL[r] }));

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
  const phone = useMediaQuery('(max-width: 48em)') ?? false;
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
    selected.length > 0 &&
    selected.every((c) => rowOf(c).reason && retirementDateError(rowOf(c).date) === null);
  const allSelected = selected.length === candidates.length;
  const missingReasons = selected.filter((c) => !rowOf(c).reason).length;

  const items = selected.map((c) => ({
    observationKey: c.observationKey,
    reason: rowOf(c).reason!,
    // R63, R60: the prefilled last-reported day, or null when the user cleared it (not recorded).
    date: rowOf(c).date === '' ? null : rowOf(c).date,
  }));

  const facts = (c: RetiredCandidate) =>
    [c.model, c.driveType, formatBytes(c.capacityBytes)].filter(Boolean).join(' · ') || '—';
  const healthBadge = (c: RetiredCandidate) => (
    <Badge variant="outline" color={stateColor(c.healthHint)}>
      <span className="badge-icon">
        <StateIcon state={c.healthHint} size={12} />
      </span>{' '}
      {HEALTH_WORD[c.healthHint]}
    </Badge>
  );
  const reasonSelect = (c: RetiredCandidate, row: Row) => (
    <Select
      aria-label={`Reason for ${c.serial}`}
      placeholder="Choose a reason"
      data={REASON_DATA}
      value={row.reason}
      onChange={(v) => patch(c, { reason: v as RetirementReason | null })}
      allowDeselect={false}
    />
  );
  const dateField = (c: RetiredCandidate, row: Row) => (
    <>
      <TextInput
        aria-label={`Date for ${c.serial}`}
        type="date"
        value={row.date}
        max={todayLocal()}
        placeholder="not recorded"
        onChange={(e) => patch(c, { date: e.currentTarget.value })}
        error={retirementDateError(row.date)}
        rightSectionWidth={64}
        rightSection={
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            aria-label={`Clear date for ${c.serial}`}
            disabled={row.date === ''}
            onClick={() => patch(c, { date: '' })}
          >
            Clear
          </Button>
        }
      />
      {row.date === '' ? (
        <Text size="xs" c="dimmed">
          Not recorded
        </Text>
      ) : null}
    </>
  );
  const selectAll = (checked: boolean) =>
    setRows((r) =>
      Object.fromEntries(
        candidates.map((c) => [
          c.observationKey,
          { ...(r[c.observationKey] ?? rowOf(c)), selected: checked },
        ]),
      ),
    );

  return (
    <section aria-label="Import retired drives">
      <Text size="sm" c="dimmed" mb="sm">
        The provider still reports these drives as decommissioned. Importing creates a retired
        record for each, so their history is kept. Choose a reason for every drive you import; the
        reported health is only a hint and is never applied. The date starts at the day the provider
        last reported the drive (approximate); clear it if you would rather record none. You can
        skip this entirely.
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
      {phone ? (
        <>
          <Checkbox
            mb="xs"
            label="Select all"
            checked={allSelected && candidates.length > 0}
            indeterminate={selected.length > 0 && !allSelected}
            onChange={(e) => selectAll(e.currentTarget.checked)}
          />
          <ul className="retired-cards" aria-label="Retired drive candidates">
            {candidates.map((c) => {
              const row = rowOf(c);
              return (
                <li key={c.observationKey} className="retired-card">
                  <div className="retired-card-top">
                    <Checkbox
                      aria-label={`Select ${c.serial}`}
                      checked={row.selected}
                      onChange={(e) => patch(c, { selected: e.currentTarget.checked })}
                    />
                    <span className="mono retired-serial">{c.serial}</span>
                  </div>
                  <Text size="sm" c="dimmed">
                    {facts(c)}
                  </Text>
                  <div className="retired-card-health">
                    <Text size="xs" c="dimmed">
                      Last known health (hint)
                    </Text>
                    {healthBadge(c)}
                  </div>
                  {reasonSelect(c, row)}
                  <div>{dateField(c, row)}</div>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <Table.ScrollContainer minWidth={760}>
          <Table verticalSpacing="xs" horizontalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>
                  <Checkbox
                    aria-label="Select all"
                    checked={allSelected && candidates.length > 0}
                    indeterminate={selected.length > 0 && !allSelected}
                    onChange={(e) => selectAll(e.currentTarget.checked)}
                  />
                </Table.Th>
                <Table.Th>Serial</Table.Th>
                <Table.Th>Drive</Table.Th>
                <Table.Th>Last known health (hint)</Table.Th>
                <Table.Th>Reason</Table.Th>
                <Table.Th>Retirement date (optional)</Table.Th>
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
                    <Table.Td>{facts(c)}</Table.Td>
                    <Table.Td>{healthBadge(c)}</Table.Td>
                    <Table.Td>{reasonSelect(c, row)}</Table.Td>
                    <Table.Td>{dateField(c, row)}</Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
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
            reason you chose and its date (or none, when cleared). This is all or nothing, and they
            can be reinstated later.
          </Text>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
