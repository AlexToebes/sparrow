import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { render } from '@testing-library/react';
import { BayGrid } from '../src/components/BayGrid';
import { slotCell, displayDimensions } from '../src/lib/grid';

const slotsFor = (n: number) =>
  Array.from({ length: n }, (_, position) => ({ id: `s${position}`, position }));

function renderGrid(rows: number, columns: number, orientation: 'landscape' | 'portrait') {
  render(
    <MantineProvider>
      <BayGrid
        rows={rows}
        columns={columns}
        orientation={orientation}
        slots={slotsFor(rows * columns)}
        renderSlot={(s) => <span>pos {s.position}</span>}
      />
    </MantineProvider>,
  );
  return screen.getByTestId('bay-grid');
}

const cellAt = (position: number) =>
  screen.getAllByTestId('bay-cell').find((c) => c.dataset.position === String(position))!;

describe('BayGrid (R4, R7)', () => {
  it('R7: 2 rows x 4 columns landscape renders 2 rows and 4 columns, filled row-major', () => {
    const grid = renderGrid(2, 4, 'landscape');
    expect(grid.dataset.rows).toBe('2');
    expect(grid.dataset.columns).toBe('4');
    expect(screen.getAllByTestId('bay-cell')).toHaveLength(8);
    expect(cellAt(0).dataset).toMatchObject({ row: '1', column: '1' });
    expect(cellAt(3).dataset).toMatchObject({ row: '1', column: '4' });
    expect(cellAt(4).dataset).toMatchObject({ row: '2', column: '1' });
    expect(cellAt(7).dataset).toMatchObject({ row: '2', column: '4' });
  });

  it('R7: the same grid in portrait is transposed to 4 rows and 2 columns', () => {
    const grid = renderGrid(2, 4, 'portrait');
    expect(grid.dataset.rows).toBe('4');
    expect(grid.dataset.columns).toBe('2');
    expect(grid.style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))');
    expect(cellAt(0).dataset).toMatchObject({ row: '1', column: '1' });
    expect(cellAt(1).dataset).toMatchObject({ row: '2', column: '1' });
    expect(cellAt(3).dataset).toMatchObject({ row: '4', column: '1' });
    expect(cellAt(4).dataset).toMatchObject({ row: '1', column: '2' });
    expect(cellAt(7).dataset).toMatchObject({ row: '4', column: '2' });
  });

  it('R4: handles other dimensions (1 x 2, 1 x 1, 3 x 5)', () => {
    expect(displayDimensions(1, 2, 'landscape')).toEqual({ rows: 1, columns: 2 });
    expect(displayDimensions(1, 1, 'portrait')).toEqual({ rows: 1, columns: 1 });
    expect(slotCell(13, 5, 'landscape')).toEqual({ row: 3, column: 4 });
    expect(slotCell(13, 5, 'portrait')).toEqual({ row: 4, column: 3 });
    const grid = renderGrid(3, 5, 'landscape');
    expect(within(grid).getAllByTestId('bay-cell')).toHaveLength(15);
  });

  it('renders cells in position order whatever the input order', () => {
    render(
      <MantineProvider>
        <BayGrid
          rows={1}
          columns={3}
          orientation="landscape"
          slots={[
            { id: 'c', position: 2 },
            { id: 'a', position: 0 },
            { id: 'b', position: 1 },
          ]}
          renderSlot={(s) => <span>{s.id}</span>}
        />
      </MantineProvider>,
    );
    expect(screen.getAllByTestId('bay-cell').map((c) => c.textContent)).toEqual(['a', 'b', 'c']);
  });
});
