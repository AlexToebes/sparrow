import { useMemo, useRef, type KeyboardEvent } from 'react';
import { Skeleton, Text } from '@mantine/core';
import type { Drive, LayoutGrid, LayoutSlot, SlotStatus } from '@sparrow/shared';
import { useDrives, useLayout, useSlotStatus } from '../api/hooks';
import { formatBytes } from '../lib/format';
import { slotCell } from '../lib/grid';
import { buildSlotView, type SlotView } from '../lib/health';
import { BayGrid } from './BayGrid';
import { CheckIcon } from './icons';
import { StateIcon } from './SlotTile';

interface SlotPickerProps {
  /** Selected slot ID (controlled). */
  value: string | null;
  onChange?: (slotId: string) => void;
  /** Accessible name of the radio group. */
  label?: string;
  /** Context only: tiles are not interactive and `value` is just highlighted. */
  readOnly?: boolean;
  /** With `readOnly`: show only the grid that holds `value`. */
  onlyGridOfValue?: boolean;
}

interface Item {
  slot: LayoutSlot;
  view: SlotView;
  gridId: string;
  /** Aria-label prefix: "Front bays" (with the enclosure name when there are several). */
  where: string;
  row: number;
  column: number;
}

/** "Front bays, Bay 3, occupied by ZL2ABC03" / "…, empty" (R70). */
export function slotRadioName(where: string, view: SlotView): string {
  return `${where}, ${view.label}, ${view.drive ? `occupied by ${view.drive.serial}` : 'empty'}`;
}

/**
 * R70: slots are chosen on the bay grids, never from a list. Every enclosure's grids are drawn with
 * the same BayGrid as the Layout page (rows, columns and orientation behave identically). Each tile
 * is a radio: click, or arrow keys to move and Space to pick. Occupied tiles stay selectable; the
 * caller then asks what to do with the occupant (R37).
 */
export function SlotPicker({
  value,
  onChange,
  label = 'Slot',
  readOnly = false,
  onlyGridOfValue = false,
}: SlotPickerProps) {
  const layout = useLayout();
  const drives = useDrives();
  const status = useSlotStatus();
  const refs = useRef(new Map<string, HTMLButtonElement>());

  const model = useMemo(() => {
    const driveById = new Map<string, Drive>((drives.data ?? []).map((d) => [d.id, d]));
    const statusBySlot = new Map<string, SlotStatus>(
      (status.data?.slots ?? []).map((s) => [s.slotId, s]),
    );
    const enclosures = layout.data?.enclosures ?? [];
    const multi = enclosures.length > 1;
    const grids: { grid: LayoutGrid; title: string; items: Item[] }[] = [];
    for (const enc of enclosures) {
      for (const grid of enc.grids) {
        const where = multi ? `${enc.name}, ${grid.name}` : grid.name;
        const items: Item[] = [...grid.slots]
          .sort((a, b) => a.position - b.position)
          .map((slot) => {
            const drive = slot.driveId ? (driveById.get(slot.driveId) ?? null) : null;
            const cell = slotCell(slot.position, grid.columns, grid.orientation);
            return {
              slot,
              view: buildSlotView(slot, drive, statusBySlot.get(slot.id) ?? null),
              gridId: grid.id,
              where,
              row: cell.row,
              column: cell.column,
            };
          });
        grids.push({ grid, title: multi ? `${enc.name} / ${grid.name}` : grid.name, items });
      }
    }
    return grids;
  }, [layout.data, drives.data, status.data]);

  if (layout.isPending) return <Skeleton height={120} radius="md" aria-label="Loading slots" />;
  if (layout.isError) return <Text c="red">Could not load the slots.</Text>;

  const shown = onlyGridOfValue
    ? model.filter((g) => g.items.some((i) => i.slot.id === value))
    : model;
  // Reading order across all grids, for arrow-key moves.
  const order: Item[] = shown.flatMap((g) =>
    [...g.items].sort((a, b) => a.row - b.row || a.column - b.column),
  );
  const tabbable = order.some((i) => i.slot.id === value) ? value : (order[0]?.slot.id ?? null);

  const pick = (item: Item | undefined) => {
    if (!item || !onChange) return;
    onChange(item.slot.id);
    refs.current.get(item.slot.id)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent, item: Item) => {
    const at = order.indexOf(item);
    let target: Item | undefined;
    switch (e.key) {
      case 'ArrowRight':
        target = order[at + 1];
        break;
      case 'ArrowLeft':
        target = order[at - 1];
        break;
      case 'ArrowDown':
      case 'ArrowUp': {
        const dr = e.key === 'ArrowDown' ? 1 : -1;
        target =
          order.find(
            (o) => o.gridId === item.gridId && o.column === item.column && o.row === item.row + dr,
          ) ?? order[at + dr];
        break;
      }
      case 'Home':
        target = order[0];
        break;
      case 'End':
        target = order[order.length - 1];
        break;
      default:
        return;
    }
    e.preventDefault();
    pick(target);
  };

  return (
    <div
      className="slot-picker"
      role={readOnly ? 'group' : 'radiogroup'}
      aria-label={label}
      data-readonly={readOnly ? 'true' : undefined}
    >
      {shown.map(({ grid, title, items }) => {
        const occupied = items.filter((i) => i.view.drive).length;
        return (
          <section key={grid.id} className="pick-grid" aria-label={readOnly ? title : undefined}>
            <div className="pick-grid-head">
              <strong>{title}</strong>
              <span className="dim">
                {occupied} of {items.length} occupied
              </span>
            </div>
            <BayGrid
              rows={grid.rows}
              columns={grid.columns}
              orientation={grid.orientation}
              slots={items.map((i) => i.slot)}
              label={readOnly ? undefined : title}
              renderSlot={(slot) => {
                const item = items.find((i) => i.slot.id === slot.id)!;
                const { view } = item;
                const selected = slot.id === value;
                const body = (
                  <>
                    <span className="pick-top">
                      <span className="pick-label">{view.label}</span>
                      <span className="pick-icon">
                        <StateIcon state={view.state} size={14} />
                      </span>
                    </span>
                    <span className="pick-body">
                      {view.drive ? (
                        <>
                          <span className="pick-serial">{view.drive.serial}</span>
                          {view.drive.capacityBytes != null ? (
                            <span className="pick-cap">
                              {formatBytes(view.drive.capacityBytes)}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <span className="pick-empty">Empty</span>
                      )}
                    </span>
                    {selected ? (
                      <span className="pick-check">
                        <CheckIcon size={12} />
                      </span>
                    ) : null}
                  </>
                );
                if (readOnly) {
                  return (
                    <div
                      className="pick-tile"
                      data-state={view.state}
                      data-selected={selected ? 'true' : undefined}
                      data-dim={selected ? undefined : 'true'}
                      aria-current={selected ? 'true' : undefined}
                      aria-label={slotRadioName(item.where, view)}
                      role="img"
                    >
                      {body}
                    </div>
                  );
                }
                return (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={slotRadioName(item.where, view)}
                    aria-description={view.note ? `${view.word}, ${view.note}` : view.word}
                    tabIndex={slot.id === tabbable ? 0 : -1}
                    ref={(el) => {
                      if (el) refs.current.set(slot.id, el);
                      else refs.current.delete(slot.id);
                    }}
                    className="pick-tile"
                    data-state={view.state}
                    data-selected={selected ? 'true' : undefined}
                    onClick={() => onChange?.(slot.id)}
                    onKeyDown={(e) => onKeyDown(e, item)}
                  >
                    {body}
                  </button>
                );
              }}
            />
          </section>
        );
      })}
    </div>
  );
}
