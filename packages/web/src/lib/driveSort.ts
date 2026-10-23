import type { Drive, Layout, SlotStatus } from '@sparrow/shared';

export type SortKey = 'serial' | 'model' | 'capacity' | 'status' | 'where' | 'health';
export type SortDir = 'asc' | 'desc';
export interface SortState {
  key: SortKey;
  dir: SortDir;
}

export const SORT_KEYS: readonly SortKey[] = [
  'serial',
  'model',
  'capacity',
  'status',
  'where',
  'health',
];
export const DEFAULT_SORT: SortState = { key: 'serial', dir: 'asc' };

/** Reads `?sort=&dir=`; anything unknown falls back to the default (serial, ascending). */
export function parseSort(sort: string | null, dir: string | null): SortState {
  const key = SORT_KEYS.find((k) => k === sort) ?? DEFAULT_SORT.key;
  return { key, dir: dir === 'desc' ? 'desc' : 'asc' };
}

/** The first click on a column sorts ascending (capacity: largest first); a second click reverses. */
export function nextSort(current: SortState, key: SortKey): SortState {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: key === 'capacity' ? 'desc' : 'asc' };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/** Case-insensitive natural order: "Bay 2" before "Bay 10". */
export const naturalCompare = (a: string, b: string): number => collator.compare(a, b);

type Part = number | string | null;

/**
 * Compares two keys element by element. Unknown values (null) stay last whichever way the sort goes,
 * so only known-versus-known results are flipped for a descending sort.
 */
function compareKeys(a: Part[], b: Part[], dir: SortDir): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? null;
    const y = b[i] ?? null;
    if (x === null && y === null) continue;
    if (x === null) return 1;
    if (y === null) return -1;
    const order =
      typeof x === 'number' && typeof y === 'number' ? x - y : naturalCompare(String(x), String(y));
    if (order !== 0) return dir === 'asc' ? order : -order;
  }
  return 0;
}

/** Position of every slot in the layout's own order: enclosure, grid, then bay position. */
export function slotRanks(layout: Layout | undefined): Map<string, number> {
  const ranks = new Map<string, number>();
  let n = 0;
  for (const e of layout?.enclosures ?? [])
    for (const g of e.grids)
      for (const s of [...g.slots].sort((a, b) => a.position - b.position)) ranks.set(s.id, n++);
  return ranks;
}

const STATUS_RANK = { installed: 0, spare: 1, retired: 2 } as const;

/** Most severe first: failed, missing, warning, ok, then no data. Non-installed drives have none. */
export function healthRank(d: Drive, status: SlotStatus | undefined): number | null {
  if (d.status !== 'installed') return null;
  if (!status) return 4;
  if (status.flag) return 1;
  switch (status.health) {
    case 'failed':
      return 0;
    case 'warning':
      return 2;
    case 'ok':
      return 3;
    default:
      return 4;
  }
}

export interface SortContext {
  ranks: Map<string, number>;
  statusBySlot: Map<string, SlotStatus>;
}

function keyOf(d: Drive, key: SortKey, ctx: SortContext): Part[] {
  switch (key) {
    case 'serial':
      return [d.serial];
    case 'model':
      return [d.model];
    case 'capacity':
      return [d.capacityBytes];
    case 'status':
      return [STATUS_RANK[d.status]];
    case 'where':
      // Installed drives in the layout's grid then bay order; spares by shelf location; retired last.
      if (d.status === 'installed') return [0, d.slotId ? (ctx.ranks.get(d.slotId) ?? null) : null];
      if (d.status === 'spare') return [1, d.storageLocation];
      return [null];
    case 'health':
      return [healthRank(d, d.slotId ? ctx.statusBySlot.get(d.slotId) : undefined)];
  }
}

const tieBreak = (a: Drive, b: Drive) =>
  naturalCompare(a.serial, b.serial) || a.id.localeCompare(b.id);

/** Sorted copy. Ties (and the default) fall back to the serial, ascending. */
export function sortDrives(drives: Drive[], sort: SortState, ctx: SortContext): Drive[] {
  return drives
    .map((d) => ({ d, k: keyOf(d, sort.key, ctx) }))
    .sort((a, b) => compareKeys(a.k, b.k, sort.dir) || tieBreak(a.d, b.d))
    .map((x) => x.d);
}

/**
 * Spares shelf order: capacity largest first (unknown last), then shelf location (missing last),
 * then serial. The server's order (normalized serial) is left alone.
 */
export function sortSpares(spares: Drive[]): Drive[] {
  return [...spares].sort(
    (a, b) =>
      compareKeys([a.capacityBytes], [b.capacityBytes], 'desc') ||
      compareKeys([a.storageLocation], [b.storageLocation], 'asc') ||
      tieBreak(a, b),
  );
}
