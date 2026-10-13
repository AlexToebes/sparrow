import type { GridOrientation, SetupInput } from '@sparrow/shared';

// Draft state and helpers of the first-run setup wizard (R77).

/** The wizard keeps grids this small so every bay label can be edited in the preview. */
export const WIZARD_MAX_DIMENSION = 12;

export const LAYOUT_LABEL_SUGGESTIONS = [
  'raidz1',
  'raidz2',
  'raidz3',
  'mirror',
  'stripe',
  'single',
];

export interface DraftGrid {
  key: string;
  name: string;
  rows: number | string;
  columns: number | string;
  orientation: GridOrientation;
  /** Labels the user typed, by position. A bay without an entry shows its number (1..n). */
  labels: Record<number, string>;
}

export interface DraftPool {
  key: string;
  name: string;
  layoutLabel: string;
  expected: string;
}

interface Preset {
  id: string;
  chip: string;
  name: string;
  columns: number;
  rows: number;
  labels?: string[];
}

/** Quick-add chips on the grids step. "Custom" starts from a small plain grid. */
export const GRID_PRESETS: Preset[] = [
  { id: 'bays-4', chip: '4 bays (4 × 1)', name: 'Front bays', columns: 4, rows: 1 },
  { id: 'bays-8', chip: '8 bays (4 × 2)', name: 'Front bays', columns: 4, rows: 2 },
  { id: 'bays-12', chip: '12 bays (4 × 3)', name: 'Front bays', columns: 4, rows: 3 },
  {
    id: 'ssd-2',
    chip: '2 internal SSDs (2 × 1, Left/Right)',
    name: 'Internal SSDs',
    columns: 2,
    rows: 1,
    labels: ['Left', 'Right'],
  },
  {
    id: 'boot-1',
    chip: '1 boot drive (1 × 1)',
    name: 'Boot drive',
    columns: 1,
    rows: 1,
    labels: ['Boot'],
  },
  { id: 'custom', chip: 'Custom', name: 'Grid', columns: 2, rows: 2 },
];

let counter = 0;
const nextKey = () => `draft-${++counter}`;

/** "Front bays", then "Front bays 2", "Front bays 3" ... so a quick-add never makes a duplicate name. */
export function freeName(base: string, taken: string[]): string {
  const used = new Set(taken.map((n) => n.trim()));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
}

export function gridFromPreset(presetId: string, existing: DraftGrid[]): DraftGrid {
  const preset =
    GRID_PRESETS.find((p) => p.id === presetId) ?? GRID_PRESETS[GRID_PRESETS.length - 1]!;
  return {
    key: nextKey(),
    name: freeName(
      preset.name,
      existing.map((g) => g.name),
    ),
    rows: preset.rows,
    columns: preset.columns,
    orientation: 'landscape',
    labels: Object.fromEntries((preset.labels ?? []).map((l, i) => [i, l])),
  };
}

export const newPool = (): DraftPool => ({
  key: nextKey(),
  name: '',
  layoutLabel: '',
  expected: '',
});

const asCount = (value: number | string): number | null =>
  typeof value === 'number' && Number.isInteger(value) ? value : null;

/** The label every bay will get: what the user typed, else its number. */
export function effectiveLabels(grid: DraftGrid): string[] {
  const r = asCount(grid.rows) ?? 0;
  const c = asCount(grid.columns) ?? 0;
  return Array.from({ length: r * c }, (_, i) => grid.labels[i] ?? String(i + 1));
}

/** What is wrong with a grid, in words, or null when it can be created. */
export function gridProblem(grid: DraftGrid, all: DraftGrid[]): string | null {
  if (grid.name.trim() === '') return 'Give the grid a name.';
  if (all.some((g) => g !== grid && g.name.trim() === grid.name.trim())) {
    return `Another grid is already named "${grid.name.trim()}".`;
  }
  for (const [what, value] of [
    ['Columns', grid.columns],
    ['Rows', grid.rows],
  ] as const) {
    const n = asCount(value);
    if (n === null || n < 1 || n > WIZARD_MAX_DIMENSION) {
      return `${what} must be a whole number from 1 to ${WIZARD_MAX_DIMENSION}.`;
    }
  }
  return null;
}

export const poolProblem = (pool: DraftPool, all: DraftPool[]): string | null => {
  if (pool.name.trim() === '') return 'Give the pool a name.';
  if (all.some((p) => p !== pool && p.name.trim() === pool.name.trim())) {
    return `Another pool is already named "${pool.name.trim()}".`;
  }
  const text = pool.expected.trim();
  if (
    text !== '' &&
    !(Number.isInteger(Number(text)) && Number(text) >= 1 && Number(text) <= 100)
  ) {
    return 'Expected drives must be a whole number from 1 to 100.';
  }
  return null;
};

export function toSetupInput(
  enclosureName: string,
  grids: DraftGrid[],
  pools: DraftPool[],
): SetupInput {
  return {
    enclosureName: enclosureName.trim(),
    grids: grids.map((g) => ({
      name: g.name.trim(),
      rows: Number(g.rows),
      columns: Number(g.columns),
      orientation: g.orientation,
      labels: effectiveLabels(g),
    })),
    pools: pools.map((p) => ({
      name: p.name.trim(),
      layoutLabel: p.layoutLabel.trim() === '' ? null : p.layoutLabel.trim(),
      expectedMembers: p.expected.trim() === '' ? null : Number(p.expected),
    })),
  };
}
