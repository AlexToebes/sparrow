import type { ReactNode } from 'react';
import type { GridOrientation } from '@sparrow/shared';
import { displayDimensions, slotCell } from '../lib/grid';

export interface BayGridProps<S extends { id: string; position: number }> {
  /** Stored dimensions: slot positions fill `rows` x `columns` row-major (landscape). */
  rows: number;
  columns: number;
  orientation: GridOrientation;
  slots: S[];
  renderSlot: (slot: S) => ReactNode;
  label?: string;
}

/**
 * The one bay grid (R4, R7). Driven only by rows, columns and orientation: portrait is the stored
 * grid transposed. Each cell carries its position and 1-based row and column as data attributes.
 */
export function BayGrid<S extends { id: string; position: number }>({
  rows,
  columns,
  orientation,
  slots,
  renderSlot,
  label,
}: BayGridProps<S>) {
  const dims = displayDimensions(rows, columns, orientation);
  const sorted = [...slots].sort((a, b) => a.position - b.position);
  return (
    <div
      className="bay-grid"
      role="group"
      aria-label={label}
      data-testid="bay-grid"
      data-rows={dims.rows}
      data-columns={dims.columns}
      data-orientation={orientation}
      style={{
        gridTemplateColumns: `repeat(${dims.columns}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${dims.rows}, auto)`,
      }}
    >
      {sorted.map((slot) => {
        const cell = slotCell(slot.position, columns, orientation);
        return (
          <div
            key={slot.id}
            className="bay-cell"
            data-testid="bay-cell"
            data-position={slot.position}
            data-row={cell.row}
            data-column={cell.column}
            style={{ gridRow: cell.row, gridColumn: cell.column }}
          >
            {renderSlot(slot)}
          </div>
        );
      })}
    </div>
  );
}
