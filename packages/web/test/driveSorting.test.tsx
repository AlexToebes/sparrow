import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from './user';
import { DrivesPage } from '../src/pages/DrivesPage';
import { SparesShelf } from '../src/components/SparesShelf';
import { makeDrive, makeSlot, mockApi, renderApp } from './utils';

const T = '2026-01-01T00:00:00.000Z';
const realMatchMedia = window.matchMedia;
function setPhone(phone: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion') || (phone && query.includes('max-width')),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

const drives = [
  makeDrive({ id: 'a', serial: 'AAA', capacityBytes: 4e12, slotId: 's2' }),
  makeDrive({ id: 'b', serial: 'BBB', capacityBytes: 12e12, slotId: 's1' }),
  makeDrive({ id: 'c', serial: 'CCC', capacityBytes: 8e12, status: 'spare', slotId: null }),
];
function mock() {
  mockApi({
    '/api/drives': drives,
    '/api/layout': {
      enclosures: [
        {
          id: 'e1',
          name: 'NAS',
          createdAt: T,
          updatedAt: T,
          grids: [
            {
              id: 'g1',
              enclosureId: 'e1',
              name: 'Front',
              rows: 1,
              columns: 2,
              orientation: 'landscape',
              createdAt: T,
              updatedAt: T,
              slots: [
                makeSlot({ id: 's1', position: 0, label: 'Bay 1', driveId: 'b' }),
                makeSlot({ id: 's2', position: 1, label: 'Bay 2', driveId: 'a' }),
              ],
            },
          ],
        },
      ],
    },
  });
}
/** The serials in the order they appear on the page. */
const order = () => screen.getAllByText(/^(AAA|BBB|CCC)$/).map((e) => e.textContent);
const header = (name: string) => screen.getByRole('columnheader', { name });

describe('Post-MVP 22: sortable Drives table', () => {
  it('sorts by serial by default; a header click reorders and toggles aria-sort', async () => {
    setPhone(false);
    mock();
    renderApp(<DrivesPage />, '/drives');
    await screen.findByText('AAA');
    expect(order()).toEqual(['AAA', 'BBB', 'CCC']);
    expect(header('Serial')).toHaveAttribute('aria-sort', 'ascending');
    expect(header('Capacity')).toHaveAttribute('aria-sort', 'none');

    await userEvent.click(within(header('Capacity')).getByRole('button'));
    expect(order()).toEqual(['BBB', 'CCC', 'AAA']);
    expect(header('Capacity')).toHaveAttribute('aria-sort', 'descending');
    expect(header('Serial')).toHaveAttribute('aria-sort', 'none');

    await userEvent.click(within(header('Capacity')).getByRole('button'));
    expect(order()).toEqual(['AAA', 'CCC', 'BBB']);
    expect(header('Capacity')).toHaveAttribute('aria-sort', 'ascending');
  });

  it('where sorts installed drives by the layout bay order (from the URL)', async () => {
    setPhone(false);
    mock();
    renderApp(<DrivesPage />, '/drives?sort=where&dir=asc');
    await screen.findByText('AAA');
    // BBB is in Bay 1, AAA in Bay 2, then the spare.
    await waitFor(() => expect(order()).toEqual(['BBB', 'AAA', 'CCC']));
    expect(header('Where')).toHaveAttribute('aria-sort', 'ascending');
  });
});

describe('Post-MVP 22: phone sort control', () => {
  it('shows a Sort by select and a direction toggle instead of headers', async () => {
    setPhone(true);
    mock();
    renderApp(<DrivesPage />, '/drives?sort=capacity&dir=desc');
    await screen.findByText('AAA');
    expect(screen.queryByRole('columnheader')).toBeNull();
    expect(order()).toEqual(['BBB', 'CCC', 'AAA']);
    await userEvent.click(screen.getByRole('button', { name: /Descending, tap to reverse/ }));
    expect(order()).toEqual(['AAA', 'CCC', 'BBB']);
    expect(screen.getByRole('button', { name: /Ascending, tap to reverse/ })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Sort by' })).toHaveValue('Sort: Capacity');
  });
});

describe('Post-MVP 22: spares shelf order', () => {
  it('lists the largest first, then location, then serial', () => {
    setPhone(false);
    mockApi({});
    const spares = [
      makeDrive({ id: '1', serial: 'AAA', status: 'spare', capacityBytes: 4e12 }),
      makeDrive({ id: '2', serial: 'BBB', status: 'spare', capacityBytes: 12e12 }),
      makeDrive({
        id: '3',
        serial: 'CCC',
        status: 'spare',
        capacityBytes: 4e12,
        storageLocation: 'Box 1',
      }),
      makeDrive({ id: '4', serial: 'DDD', status: 'spare', capacityBytes: null }),
    ];
    renderApp(<SparesShelf spares={spares} />);
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual([
      'BBB',
      'CCC',
      'AAA',
      'DDD',
    ]);
  });
});
