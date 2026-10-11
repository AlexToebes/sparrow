import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SlotPicker } from '../src/components/SlotPicker';
import { makeSlot, renderApp } from './utils';
import { enclosure, fixtureData, grid, setupServer } from './server';

function Controlled({
  initial = null,
  readOnly = false,
}: {
  initial?: string | null;
  readOnly?: boolean;
}) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <>
      <SlotPicker value={value} onChange={setValue} readOnly={readOnly} />
      <output data-testid="picked">{value ?? 'none'}</output>
    </>
  );
}

describe('SlotPicker (R70)', () => {
  it('R70: draws each grid with the shared BayGrid, landscape as stored and portrait transposed', async () => {
    const { slots } = fixtureData();
    const second = ['a', 'b', 'c', 'd', 'e', 'f'].map((k, i) =>
      makeSlot({ id: `x${k}`, gridId: 'g2', position: i, label: `Port ${i + 1}` }),
    );
    setupServer(
      {},
      {
        layoutGrids: [
          enclosure('e1', 'NAS', [
            grid('g1', 'Front bays', 2, 2, slots),
            grid('g2', 'Side bays', 2, 3, second, 'portrait'),
          ]),
        ],
      },
    );
    renderApp(<Controlled />);
    await screen.findByRole('radio', { name: 'Front bays, Bay 1, occupied by AAA0' });
    const grids = screen.getAllByTestId('bay-grid');
    expect(grids).toHaveLength(2);
    expect(grids[0]).toHaveAttribute('data-orientation', 'landscape');
    expect(grids[0]).toHaveAttribute('data-columns', '2');
    // 2 rows x 3 columns stored, portrait: 3 rows x 2 columns, same BayGrid maths as the Layout page.
    expect(grids[1]).toHaveAttribute('data-orientation', 'portrait');
    expect(grids[1]).toHaveAttribute('data-rows', '3');
    expect(grids[1]).toHaveAttribute('data-columns', '2');
    expect(within(grids[1]!).getAllByRole('radio')).toHaveLength(6);
  });

  it('R70: tiles are radios named by grid, slot and occupant, with serial, capacity and "Empty" shown', async () => {
    setupServer();
    renderApp(<Controlled />);
    const group = await screen.findByRole('radiogroup', { name: 'Slot' });
    const occupied = within(group).getByRole('radio', {
      name: 'Front bays, Bay 1, occupied by AAA0',
    });
    expect(occupied).toHaveAttribute('aria-checked', 'false');
    expect(within(occupied).getByText('AAA0')).toBeInTheDocument();
    expect(within(occupied).getByText('4 TB')).toBeInTheDocument();
    const empty = within(group).getByRole('radio', { name: 'Front bays, Bay 2, empty' });
    expect(within(empty).getByText('Empty')).toBeInTheDocument();
    // Health is never color alone: the occupied tile has an icon (the warning one for Bay 3).
    await screen.findByRole('radio', { name: 'Front bays, Bay 3, occupied by CCC2' });
    expect(occupied.querySelector('.pick-icon svg')).not.toBeNull();
  });

  it('R70: clicking selects exactly one tile; an occupied tile is selectable too', async () => {
    setupServer();
    renderApp(<Controlled />);
    const empty = await screen.findByRole('radio', { name: /Bay 2, empty/ });
    const occupied = screen.getByRole('radio', { name: /Bay 1, occupied by AAA0/ });
    await userEvent.click(empty);
    expect(empty).toHaveAttribute('aria-checked', 'true');
    expect(within(empty).getByText('Empty')).toBeInTheDocument();
    expect(empty.querySelector('.pick-check')).not.toBeNull();
    expect(screen.getByTestId('picked')).toHaveTextContent('s1');
    await userEvent.click(occupied);
    expect(occupied).toHaveAttribute('aria-checked', 'true');
    expect(empty).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('picked')).toHaveTextContent('s0');
  });

  it('R70: keyboard - one tab stop, arrows move and select, Space picks', async () => {
    setupServer();
    renderApp(<Controlled initial="s0" />);
    const bay1 = await screen.findByRole('radio', { name: /Bay 1,/ });
    const bay2 = screen.getByRole('radio', { name: /Bay 2,/ });
    const bay3 = screen.getByRole('radio', { name: /Bay 3,/ });
    // Roving tabindex: only the selected tile is in the tab order.
    expect(bay1).toHaveAttribute('tabindex', '0');
    expect(bay2).toHaveAttribute('tabindex', '-1');
    bay1.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(bay2).toHaveFocus();
    expect(bay2).toHaveAttribute('aria-checked', 'true');
    await userEvent.keyboard('{ArrowDown}'); // 2 x 2: Bay 2 sits above Bay 4
    expect(screen.getByRole('radio', { name: /Bay 4,/ })).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(bay1).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(bay3).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(screen.getByTestId('picked')).toHaveTextContent('s3');
    // Space on a focused tile selects it (a native button click).
    bay2.focus();
    await userEvent.keyboard(' ');
    expect(screen.getByTestId('picked')).toHaveTextContent('s1');
  });

  it('R70: tiles are keyboard focusable buttons', async () => {
    setupServer();
    renderApp(<Controlled />);
    const first = await screen.findByRole('radio', { name: /Bay 1,/ });
    expect(first.tagName).toBe('BUTTON');
    await userEvent.tab();
    expect(first).toHaveFocus();
  });

  it('R70: with several enclosures the enclosure name is part of the tile name', async () => {
    const { slots } = fixtureData();
    setupServer(
      {},
      {
        layoutGrids: [
          enclosure('e1', 'NAS', [grid('g1', 'Front bays', 2, 2, slots)]),
          enclosure('e2', 'Shelf', [
            grid(
              'g2',
              'Top',
              1,
              1,
              [makeSlot({ id: 'z0', gridId: 'g2', position: 0, label: 'A' })],
              'landscape',
              'e2',
            ),
          ]),
        ],
      },
    );
    renderApp(<Controlled />);
    expect(
      await screen.findByRole('radio', { name: 'NAS, Front bays, Bay 1, occupied by AAA0' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Shelf, Top, A, empty' })).toBeInTheDocument();
  });

  it('R70: read-only mode shows the one grid with the bay highlighted and nothing to click', async () => {
    const { slots } = fixtureData();
    setupServer(
      {},
      {
        layoutGrids: [
          enclosure('e1', 'NAS', [
            grid('g1', 'Front bays', 2, 2, slots),
            grid('g2', 'Other', 1, 1, [makeSlot({ id: 'z0', gridId: 'g2', position: 0 })]),
          ]),
        ],
      },
    );
    renderApp(<SlotPicker value="s2" readOnly onlyGridOfValue />);
    const current = await screen.findByLabelText('Front bays, Bay 3, occupied by CCC2');
    expect(current).toHaveAttribute('aria-current', 'true');
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getAllByTestId('bay-grid')).toHaveLength(1);
  });
});
