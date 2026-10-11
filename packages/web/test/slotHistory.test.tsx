import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from './user';
import { App } from '../src/App';
import { renderApp } from './utils';
import { setupServer } from './server';

const T = '2026-10-11T09:00:00.000Z';
const history = (slotId: string, label: string) => ({
  slot: { id: slotId, label, gridName: 'Front bays' },
  entries: [
    {
      driveId: 'd2',
      serial: 'CCC2',
      capacityBytes: 4e12,
      driveType: 'HDD',
      installedOn: '2022-08-19',
      installedRecordedAt: T,
      removedOn: null,
      removedRecordedAt: null,
      outcome: null,
    },
    {
      driveId: 'x1',
      serial: 'GONE-SPARES',
      capacityBytes: 4e12,
      driveType: 'HDD',
      installedOn: '2021-01-01',
      installedRecordedAt: T,
      removedOn: '2021-06-01',
      removedRecordedAt: T,
      outcome: { kind: 'spares' },
    },
    {
      driveId: 'x2',
      serial: 'GONE-MOVED',
      capacityBytes: 2e12,
      driveType: 'HDD',
      installedOn: null,
      installedRecordedAt: T,
      removedOn: '2020-02-02',
      removedRecordedAt: T,
      outcome: { kind: 'moved', toSlotId: 's3', toLabel: 'Bay 4', toGridName: 'Front bays' },
    },
    {
      driveId: 'x3',
      serial: 'GONE-RETIRED',
      capacityBytes: 4e12,
      driveType: 'HDD',
      installedOn: '2019-01-01',
      installedRecordedAt: T,
      removedOn: '2020-01-01',
      removedRecordedAt: T,
      outcome: { kind: 'retired', reason: 'failed' },
    },
  ],
});

const openPanel = async (name: RegExp) => {
  await userEvent.click(await screen.findByRole('button', { name }));
  return screen.findByRole('dialog');
};

describe('Slot history (R74)', () => {
  it('R74: an occupied bay has Drive | Slot; Slot lists every drive with how it left', async () => {
    setupServer({ 'GET /api/slots/s2/history': history('s2', 'Bay 3') });
    renderApp(<App />);
    const panel = await openPanel(/^Bay 3, /);
    const toggle = await within(panel).findByRole('radiogroup', { name: 'History for' });
    expect(within(toggle).getByRole('radio', { name: 'Drive' })).toBeChecked();
    expect(await within(panel).findByText('No history yet.')).toBeInTheDocument();
    await userEvent.click(within(toggle).getByRole('radio', { name: 'Slot' }));
    const list = await within(panel).findByRole('region', { name: 'Slot history of Bay 3' });
    expect(within(panel).queryByText('No history yet.')).not.toBeInTheDocument();
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent('CCC2');
    expect(items[0]).toHaveTextContent('in this slot since 2022-08-19');
    expect(items[1]).toHaveTextContent('installed 2021-01-01 → removed 2021-06-01, back to spares');
    expect(items[2]).toHaveTextContent('installed not recorded');
    expect(items[2]).toHaveTextContent('→ removed 2020-02-02, moved to Bay 4');
    expect(items[3]).toHaveTextContent('→ removed 2020-01-01, retired (failed)');
    expect(within(items[1]!).getByRole('link', { name: 'GONE-SPARES' })).toHaveAttribute(
      'href',
      '/drives?drive=x1',
    );
  });

  it('R74: an empty bay shows only the slot history, no toggle', async () => {
    setupServer({
      'GET /api/slots/s1/history': {
        ...history('s1', 'Bay 2'),
        entries: history('s1', 'Bay 2').entries.slice(1, 2),
      },
    });
    renderApp(<App />);
    const panel = await openPanel(/^Bay 2, Empty/);
    expect(await within(panel).findByRole('heading', { name: 'History' })).toBeInTheDocument();
    expect(await within(panel).findByText('GONE-SPARES')).toBeInTheDocument();
    expect(
      within(panel).queryByRole('radiogroup', { name: 'History for' }),
    ).not.toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Assign a drive' })).toBeInTheDocument();
  });

  it('R74: spare and retired drives show only their own history', async () => {
    setupServer();
    renderApp(<App />, '/drives');
    await userEvent.click(await screen.findByText('SPARE9'));
    expect(await screen.findByRole('heading', { name: 'History' })).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'History for' })).not.toBeInTheDocument();
  });

  it('R74: an installed drive on the Drives page offers the toggle for its current bay', async () => {
    setupServer({ 'GET /api/slots/s0/history': history('s0', 'Bay 1') });
    renderApp(<App />, '/drives?drive=d0');
    const toggle = await screen.findByRole('radiogroup', { name: 'History for' });
    await userEvent.click(within(toggle).getByRole('radio', { name: 'Slot' }));
    expect(
      await screen.findByRole('region', { name: 'Slot history of Bay 1' }),
    ).toBeInTheDocument();
  });

  it('R74: a life-story "Slot history" link opens that bay on its slot history', async () => {
    setupServer({
      'GET /api/drives/d2/events': [
        {
          id: 'e1',
          driveId: 'd2',
          type: 'drive-installed',
          at: T,
          payload: {
            slotId: 's2',
            slotLabel: 'Bay 3',
            gridName: 'Front bays',
            installedOn: '2022-08-19',
          },
        },
      ],
      'GET /api/slots/s2/history': history('s2', 'Bay 3'),
    });
    renderApp(<App />);
    const panel = await openPanel(/^Bay 3, /);
    await userEvent.click(
      await within(panel).findByRole('link', { name: 'Slot history of Bay 3' }),
    );
    expect(
      await screen.findByRole('region', { name: 'Slot history of Bay 3' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Slot' })).toBeChecked();
  });
});
