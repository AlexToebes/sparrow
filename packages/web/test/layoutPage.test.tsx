import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../src/App';
import { makeDrive, makeSlot, mockApi, renderApp } from './utils';

const T = '2026-01-01T00:00:00.000Z';
const recent = new Date(Date.now() - 2 * 60_000).toISOString();

function fixtures(over: { providerStale?: boolean } = {}) {
  const slots = [
    makeSlot({ id: 's0', position: 0, label: 'Bay 1', driveId: 'd0' }),
    makeSlot({ id: 's1', position: 1, label: 'Bay 2', driveId: 'd1' }),
    makeSlot({ id: 's2', position: 2, label: 'Bay 3', driveId: 'd2' }),
    makeSlot({ id: 's3', position: 3, label: 'Bay 4' }),
  ];
  const drives = [
    makeDrive({ id: 'd0', serial: 'AAA0', slotId: 's0' }),
    makeDrive({ id: 'd1', serial: 'AAA1', slotId: 's1' }),
    makeDrive({ id: 'd2', serial: 'AAA2', slotId: 's2' }),
    makeDrive({ id: 'd9', serial: 'SPARE9', status: 'spare', condition: 'tested' }),
  ];
  const st = (slotId: string, driveId: string, extra = {}) => ({
    slotId,
    driveId,
    health: 'ok',
    lastReportedAt: recent,
    temperatureC: 30,
    detailUrl: null,
    stale: false,
    flag: null,
    ...extra,
  });
  mockApi({
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
              name: 'Front bays',
              rows: 2,
              columns: 2,
              orientation: 'landscape',
              createdAt: T,
              updatedAt: T,
              slots,
            },
          ],
        },
      ],
    },
    '/api/drives': drives,
    '/api/drives?status=spare': [drives[3]],
    '/api/inbox': { entries: [], unidentified: [], retiredCandidates: [], count: 2 },
    '/api/provider/status': {
      providerId: 'scrutiny',
      capabilities: {},
      reachable: true,
      lastSuccessAt: recent,
      lastAttemptAt: recent,
      lastError: null,
      observationCount: 3,
    },
    '/api/status': {
      providerId: 'scrutiny',
      providerStale: over.providerStale ?? false,
      staleAfterHours: 36,
      lastSuccessAt: recent,
      slots: [
        st('s0', 'd0'),
        st('s1', 'd1', { health: 'failed' }),
        st('s2', 'd2', { flag: { kind: 'missing', reason: 'not-reported' } }),
      ],
    },
    '/api/pools': [
      { id: 'p1', name: 'tank', layoutLabel: 'raidz2', createdAt: T, updatedAt: T, memberCount: 1 },
    ],
    '/api/pools/p1': {
      id: 'p1',
      name: 'tank',
      layoutLabel: 'raidz2',
      createdAt: T,
      updatedAt: T,
      memberCount: 1,
      members: [
        {
          membershipId: 'm1',
          driveId: 'd0',
          serial: 'AAA0',
          role: 'data',
          startedAt: T,
          slotLabel: 'Bay 1',
        },
      ],
    },
    '/api/drives/d1/events': [
      {
        id: 'e2',
        driveId: 'd1',
        type: 'drive-installed',
        at: '2026-02-01T00:00:00.000Z',
        payload: { slotLabel: 'Bay 2', gridName: 'Front bays' },
      },
      {
        id: 'e1',
        driveId: 'd1',
        type: 'drive-created',
        at: '2026-01-01T00:00:00.000Z',
        payload: {},
      },
    ],
  });
}

describe('Layout page (R4, R15, R18, R47)', () => {
  it('shows the summary, problem chips, grid, pool badge and spares shelf', async () => {
    fixtures();
    renderApp(<App />);
    expect(await screen.findByText('Two things need a look')).toBeInTheDocument();
    const chips = screen.getByLabelText('Problems and counts');
    expect(within(chips).getByText('Bay 2 failed')).toBeInTheDocument();
    expect(within(chips).getByText('Bay 3 missing')).toBeInTheDocument();
    expect(within(chips).getByText('2 discovered')).toBeInTheDocument();
    expect(within(chips).getByText(/spare on hand/)).toBeInTheDocument();
    expect(screen.getByText('2 × 2 · 3 of 4 occupied')).toBeInTheDocument();
    expect(
      await screen.findByText('tank', { selector: '.tile-pool *, .tile-pool' }),
    ).toBeInTheDocument();
    const shelf = screen.getByLabelText('Spares shelf');
    expect(within(shelf).getByText('SPARE9')).toBeInTheDocument();
    expect(screen.getAllByTestId('bay-cell')).toHaveLength(4);
  });

  it('R71: the navigation has three tabs and no Discovered tab; the chip links to /drives/discovered', async () => {
    fixtures();
    renderApp(<App />);
    const chip = await screen.findByRole('link', { name: /2 discovered/ });
    expect(chip).toHaveAttribute('href', '/drives/discovered');
    expect(screen.getByText('2 newly discovered drives are waiting.')).toBeInTheDocument();
    const nav = screen.getAllByRole('navigation', { name: 'Main' })[0]!;
    expect(
      within(nav)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Layout', 'Drives', 'Settings']);
    expect(screen.queryByLabelText('2 discovered')).not.toBeInTheDocument();
  });

  it('clicking a problem chip opens the detail panel with the drive and its life story', async () => {
    fixtures();
    renderApp(<App />);
    await userEvent.click(await screen.findByText('Bay 2 failed'));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('AAA1')).toBeInTheDocument();
    expect(await within(panel).findByText('Added to Sparrow')).toBeInTheDocument();
    expect(within(panel).getByText('Installed in Front bays, Bay 2')).toBeInTheDocument();
    expect(within(panel).getByText('after 31 d')).toBeInTheDocument();
  });

  it('R47: a stale provider shows one banner, not per-slot stale chips', async () => {
    fixtures({ providerStale: true });
    renderApp(<App />);
    expect(await screen.findByText('Scrutiny data is out of date')).toBeInTheDocument();
  });
});
