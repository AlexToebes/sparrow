import { randomUUID } from 'node:crypto';
import type {
  CreateEnclosureInput,
  CreateGridInput,
  GridOrientation,
  Layout,
  UpdateGridInput,
  UpdateSlotInput,
} from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import * as repo from '../db/layout-repo.js';
import type { EnclosureRow, GridRow, SlotRow, Tx } from '../db/layout-repo.js';
import { conflict, notFound } from './errors.js';
import { recordActivity, type EventInput } from './activities.js';

/** app_meta key that records the one-time seeding (R5). */
export const LAYOUT_SEEDED_KEY = 'layout.seeded';

export interface OccupiedSlot {
  slotId: string;
  gridId: string;
  gridName: string;
  position: number;
  label: string | null;
  driveId: string;
}

const nowIso = () => new Date().toISOString();

const makeEnclosure = (name: string): EnclosureRow => {
  const at = nowIso();
  return { id: randomUUID(), name, createdAt: at, updatedAt: at };
};

const makeGrid = (
  enclosureId: string,
  input: { name: string; rows: number; columns: number; orientation: GridOrientation },
): GridRow => {
  const at = nowIso();
  return { id: randomUUID(), enclosureId, ...input, createdAt: at, updatedAt: at };
};

/** One fresh slot per listed position; labels[position] is used when given. */
const makeSlots = (
  gridId: string,
  positions: number[],
  labels: (string | null)[] = [],
): SlotRow[] => {
  const at = nowIso();
  return positions.map((position) => ({
    id: randomUUID(),
    gridId,
    position,
    label: labels[position] ?? null,
    createdAt: at,
    updatedAt: at,
  }));
};

/** A grid and its slots as one event payload: the whole record, so the log can rebuild or undo it. */
const gridPayload = (grid: GridRow, slotRows: SlotRow[]): Record<string, unknown> => ({
  ...grid,
  slots: slotRows,
});

/** Records the one `layout-updated` activity of a layout action, if it changed anything. */
function recordLayout(tx: Tx, events: EventInput[]): void {
  if (events.length > 0) recordActivity(tx, { kind: 'layout-updated', events });
}

const positionsUpTo = (count: number) => Array.from({ length: count }, (_, i) => i);

const groupBy = <T, K>(items: T[], key: (item: T) => K): Map<K, T[]> => {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  return groups;
};

/** R40: removing slots is refused while any of them holds a drive. */
function assertNoOccupiedSlots(
  tx: Tx,
  doomed: SlotRow[],
  gridsById: Map<string, GridRow>,
  blockedAction: string,
): void {
  const occupied = repo.occupants(
    tx,
    doomed.map((slot) => slot.id),
  );
  if (occupied.length === 0) return;

  const details: OccupiedSlot[] = occupied.map((occ) => {
    const slot = doomed.find((s) => s.id === occ.slotId)!;
    return {
      slotId: slot.id,
      gridId: slot.gridId,
      gridName: gridsById.get(slot.gridId)?.name ?? '',
      position: slot.position,
      label: slot.label,
      driveId: occ.driveId,
    };
  });
  const names = details.map(
    (d) => `"${d.gridName}" ${d.label !== null ? `"${d.label}"` : `slot ${d.position + 1}`}`,
  );
  throw conflict(
    `${blockedAction} is blocked: occupied slots would be removed (${names.join(', ')}). Resolve their drives first.`,
    { occupied: details },
  );
}

function assertGridNameFree(tx: Tx, enclosureId: string, name: string, exceptGridId?: string) {
  const clash = repo
    .selectGrids(tx, enclosureId)
    .some((g) => g.name === name && g.id !== exceptGridId);
  if (clash) throw conflict(`A grid named "${name}" already exists in this enclosure`);
}

function requireEnclosure(tx: Tx, id: string): EnclosureRow {
  const row = repo.getEnclosure(tx, id);
  if (!row) throw notFound(`Enclosure ${id} not found`);
  return row;
}

function requireGrid(tx: Tx, id: string): GridRow {
  const row = repo.getGrid(tx, id);
  if (!row) throw notFound(`Grid ${id} not found`);
  return row;
}

function requireSlot(tx: Tx, id: string): SlotRow {
  const row = repo.getSlot(tx, id);
  if (!row) throw notFound(`Slot ${id} not found`);
  return row;
}

/** Layout rules (R4, R5, R7, R38 to R40). Each call runs in one transaction. */
export function createLayoutService(db: AppDb) {
  const run = <T>(fn: (tx: Tx) => T): T => db.transaction(fn);

  return {
    getLayout(): Layout {
      return run((tx) => {
        const occupantBySlot = new Map(repo.occupants(tx).map((o) => [o.slotId, o.driveId]));
        const slotsByGrid = groupBy(repo.selectSlots(tx), (s) => s.gridId);
        const gridsByEnclosure = groupBy(repo.selectGrids(tx), (g) => g.enclosureId);
        return {
          enclosures: repo.selectEnclosures(tx).map((enclosure) => ({
            ...enclosure,
            grids: (gridsByEnclosure.get(enclosure.id) ?? []).map((grid) => ({
              ...grid,
              slots: (slotsByGrid.get(grid.id) ?? []).map((slot) => ({
                ...slot,
                driveId: occupantBySlot.get(slot.id) ?? null,
              })),
            })),
          })),
        };
      });
    },

    createEnclosure(input: CreateEnclosureInput): EnclosureRow {
      return run((tx) => {
        const row = makeEnclosure(input.name);
        repo.insertEnclosure(tx, row);
        recordLayout(tx, [{ type: 'enclosure-created', payload: { ...row } }]);
        return row;
      });
    },

    renameEnclosure(id: string, input: CreateEnclosureInput): EnclosureRow {
      return run((tx) => {
        const before = requireEnclosure(tx, id);
        const row = { ...before, name: input.name, updatedAt: nowIso() };
        repo.updateEnclosure(tx, row);
        if (before.name !== row.name) {
          recordLayout(tx, [
            {
              type: 'enclosure-renamed',
              payload: { enclosureId: id, from: before.name, to: row.name },
            },
          ]);
        }
        return row;
      });
    },

    /** Refused while any slot in the enclosure is occupied. Otherwise slots, grids, then the enclosure. */
    deleteEnclosure(id: string): void {
      run((tx) => {
        const enclosure = requireEnclosure(tx, id);
        const gridRows = repo.selectGrids(tx, id);
        const gridsById = new Map(gridRows.map((g) => [g.id, g]));
        const slotRows = repo.selectSlots(
          tx,
          gridRows.map((g) => g.id),
        );
        assertNoOccupiedSlots(tx, slotRows, gridsById, `Deleting "${enclosure.name}"`);
        repo.deleteSlots(
          tx,
          slotRows.map((s) => s.id),
        );
        for (const grid of gridRows) repo.deleteGrid(tx, grid.id);
        repo.deleteEnclosure(tx, id);
        // Each grid goes with its slots, then the enclosure: every deleted record is in the log.
        recordLayout(tx, [
          ...gridRows.map((grid): EventInput => ({
            type: 'grid-deleted',
            payload: gridPayload(
              grid,
              slotRows.filter((s) => s.gridId === grid.id),
            ),
          })),
          { type: 'enclosure-deleted', payload: { ...enclosure } },
        ]);
      });
    },

    createGrid(enclosureId: string, input: CreateGridInput): GridRow {
      return run((tx) => {
        requireEnclosure(tx, enclosureId);
        assertGridNameFree(tx, enclosureId, input.name);
        const grid = makeGrid(enclosureId, input);
        repo.insertGrid(tx, grid);
        const slotRows = makeSlots(grid.id, positionsUpTo(grid.rows * grid.columns));
        repo.insertSlots(tx, slotRows);
        recordLayout(tx, [{ type: 'grid-created', payload: gridPayload(grid, slotRows) }]);
        return grid;
      });
    },

    /**
     * Name, orientation and dimensions. Orientation changes rendering only. Dimensions change the
     * slot count: growing adds slots at the new positions, shrinking removes positions at or above
     * the new count (R40: refused if any of them is occupied).
     */
    updateGrid(id: string, input: UpdateGridInput): GridRow {
      return run((tx) => {
        const current = requireGrid(tx, id);
        const next = {
          ...current,
          name: input.name ?? current.name,
          rows: input.rows ?? current.rows,
          columns: input.columns ?? current.columns,
          orientation: input.orientation ?? current.orientation,
          updatedAt: nowIso(),
        };
        if (next.name !== current.name) assertGridNameFree(tx, current.enclosureId, next.name, id);

        const existing = repo.selectSlots(tx, [id]);
        const targetCount = next.rows * next.columns;
        const doomed = existing.filter((s) => s.position >= targetCount);
        if (doomed.length > 0) {
          assertNoOccupiedSlots(
            tx,
            doomed,
            new Map([[current.id, current]]),
            `Resizing "${current.name}" to ${next.rows}x${next.columns}`,
          );
          repo.deleteSlots(
            tx,
            doomed.map((s) => s.id),
          );
        }
        const present = new Set(existing.map((s) => s.position));
        const missing = positionsUpTo(targetCount).filter((p) => !present.has(p));
        const added = makeSlots(id, missing);
        repo.insertSlots(tx, added);

        repo.updateGrid(tx, next);
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        for (const field of ['name', 'rows', 'columns', 'orientation'] as const) {
          if (current[field] !== next[field]) {
            changes[field] = { from: current[field], to: next[field] };
          }
        }
        if (Object.keys(changes).length > 0) {
          // Growing or shrinking adds or removes slots: those records are part of the change.
          recordLayout(tx, [
            {
              type: 'grid-updated',
              payload: {
                gridId: id,
                changes,
                // The grid as it is after the change (R75): `changes` lists only what differs, and the
                // feed needs the grid's name and both dimensions to say "resized 4 × 2 → 4 × 3".
                after: {
                  name: next.name,
                  rows: next.rows,
                  columns: next.columns,
                  orientation: next.orientation,
                },
                ...(added.length > 0 ? { slotsAdded: added } : {}),
                ...(doomed.length > 0 ? { slotsRemoved: doomed } : {}),
              },
            },
          ]);
        }
        return next;
      });
    },

    /** Refused while any slot in the grid is occupied. Otherwise slots, then the grid. */
    deleteGrid(id: string): void {
      run((tx) => {
        const grid = requireGrid(tx, id);
        const slotRows = repo.selectSlots(tx, [id]);
        assertNoOccupiedSlots(tx, slotRows, new Map([[grid.id, grid]]), `Deleting "${grid.name}"`);
        repo.deleteSlots(
          tx,
          slotRows.map((s) => s.id),
        );
        repo.deleteGrid(tx, id);
        recordLayout(tx, [{ type: 'grid-deleted', payload: gridPayload(grid, slotRows) }]);
      });
    },

    /** R39: a label change touches only the label. The slot ID and any occupant stay put. */
    updateSlotLabel(id: string, input: UpdateSlotInput): SlotRow {
      return run((tx) => {
        const before = requireSlot(tx, id);
        repo.updateSlotLabel(tx, id, input.label, nowIso());
        const after = requireSlot(tx, id);
        if (before.label !== after.label) {
          recordLayout(tx, [
            {
              type: 'slot-relabeled',
              slotId: id,
              payload: { from: before.label, to: after.label },
            },
          ]);
        }
        return after;
      });
    },
  };
}

export type LayoutService = ReturnType<typeof createLayoutService>;

interface SeedGrid {
  name: string;
  rows: number;
  columns: number;
  labels: string[];
}

/** R5: the initial NAS layout. Must match the spec exactly. */
const SEED_GRIDS: SeedGrid[] = [
  {
    name: 'Front bays',
    rows: 2,
    columns: 4,
    labels: ['1', '2', '3', '4', '5', '6', '7', '8'],
  },
  { name: 'Internal SSDs', rows: 1, columns: 2, labels: ['Left', 'Right'] },
  { name: 'Boot', rows: 1, columns: 1, labels: ['NVMe'] },
];

/**
 * Seeds the R5 layout once. Runs in one transaction. It creates the NAS only when there are no
 * enclosures yet, and it sets `layout.seeded` either way, so it never runs again, even after the
 * user deletes everything. Returns true when it ran.
 */
export function seedInitialLayout(db: AppDb): boolean {
  return db.transaction((tx) => {
    if (repo.getMeta(tx, LAYOUT_SEEDED_KEY) !== null) return false;

    if (repo.selectEnclosures(tx).length === 0) {
      const enclosure = makeEnclosure('NAS');
      repo.insertEnclosure(tx, enclosure);
      const events: EventInput[] = [{ type: 'enclosure-created', payload: { ...enclosure } }];
      for (const spec of SEED_GRIDS) {
        const grid = makeGrid(enclosure.id, {
          name: spec.name,
          rows: spec.rows,
          columns: spec.columns,
          orientation: 'landscape',
        });
        repo.insertGrid(tx, grid);
        const slotRows = makeSlots(grid.id, positionsUpTo(grid.rows * grid.columns), spec.labels);
        repo.insertSlots(tx, slotRows);
        events.push({ type: 'grid-created', payload: gridPayload(grid, slotRows) });
      }
      // No unlogged state change: the seed is ONE `layout-updated` activity (R75).
      recordLayout(tx, events);
    }

    repo.setMeta(tx, LAYOUT_SEEDED_KEY, nowIso());
    return true;
  });
}
