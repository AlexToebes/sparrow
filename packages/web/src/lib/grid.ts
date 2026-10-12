import type { GridOrientation } from '@sparrow/shared';

export interface CellPosition {
  /** 1-based CSS grid row and column. */
  row: number;
  column: number;
}

/**
 * Maps a slot position to a cell (R4, R7). Positions fill row-major in the stored grid (landscape).
 * Portrait is the same grid transposed: 2 rows of 4 slots (landscape) renders as 4 rows of 2.
 */
export function slotCell(
  position: number,
  columns: number,
  orientation: GridOrientation,
): CellPosition {
  const row = Math.floor(position / columns);
  const col = position % columns;
  return orientation === 'portrait'
    ? { row: col + 1, column: row + 1 }
    : { row: row + 1, column: col + 1 };
}

export function displayDimensions(
  rows: number,
  columns: number,
  orientation: GridOrientation,
): { rows: number; columns: number } {
  return orientation === 'portrait' ? { rows: columns, columns: rows } : { rows, columns };
}

/** "4 × 2": columns × rows as drawn (orientation applied). The one way grid sizes are written. */
export function formatGridSize(
  rows: number,
  columns: number,
  orientation: GridOrientation,
): string {
  const d = displayDimensions(rows, columns, orientation);
  return `${d.columns} × ${d.rows}`;
}
