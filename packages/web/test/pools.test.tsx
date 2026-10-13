import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from './user';
import { App } from '../src/App';
import { sizeCheckText } from '../src/lib/poolSize';
import { errorResponse, posts, setupServer, T } from './server';
import { act, ev } from './activities';
import { renderApp } from './utils';

const pool = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  layoutLabel: 'raidz2',
  expectedMembers: null,
  createdAt: T,
  updatedAt: T,
  memberCount: 0,
  sizeCheck: null,
  smallestMemberBytes: null,
  sparesFit: 0,
  ...over,
});

const member = (driveId: string, serial: string, over: Record<string, unknown> = {}) => ({
  driveId,
  serial,
  capacityBytes: 4e12,
  role: 'data',
  installedOn: null,
  slotId: `s-${driveId}`,
  slotLabel: 'Bay 1',
  ...over,
});

function twoPools(extra: Record<string, unknown> = {}) {
  const tank = pool('p1', 'tank', { expectedMembers: 3, memberCount: 2, sizeCheck: 'fewer' });
  const scratch = pool('p2', 'scratch', { layoutLabel: null });
  return setupServer({
    'GET /api/pools': [tank, scratch],
    'GET /api/pools/p1': {
      ...tank,
      members: [
        member('d0', 'AAA0'),
        member('d2', 'CCC2', { slotLabel: 'Bay 3', role: 'hot-spare' }),
      ],
    },
    'GET /api/pools/p2': { ...scratch, members: [] },
    ...extra,
  });
}

describe('sizeCheckText (R34)', () => {
  it('words the three states', () => {
    expect(sizeCheckText('fewer', 5, 6)).toBe('5 of 6 drives — one missing');
    expect(sizeCheckText('fewer', 3, 6)).toBe('3 of 6 drives — 3 missing');
    expect(sizeCheckText('more', 7, 6)).toBe('7 drives, expected 6');
    expect(sizeCheckText('ok', 6, 6)).toBe('6 of 6 drives');
    expect(sizeCheckText(null, 6, null)).toBeNull();
  });
});

describe('Pool history on the card (activities with an event on the pool)', () => {
  const pool1: [string, string] = ['p1', 'tank'];
  // As the API returns them: newest first by seq.
  const history = [
    act('pool-left', '2026-10-11T09:00:00.000Z', null, [
      ev('pool-left', { drive: ['d0', 'AAA0'], pool: pool1, payload: { poolRole: 'data' } }),
    ]),
    act('pool-edited', '2026-10-10T09:00:00.000Z', null, [
      ev('pool-updated', {
        pool: pool1,
        payload: { changes: { name: { from: 'old', to: 'tank' } } },
      }),
    ]),
    act('pool-role-changed', '2026-10-09T09:00:00.000Z', null, [
      ev('pool-role-changed', {
        drive: ['d2', 'CCC2'],
        pool: pool1,
        payload: { from: 'data', to: 'hot-spare' },
      }),
    ]),
    // Recorded after the pool was created, but the user dated it years back (F12).
    act('pool-joined', '2026-10-08T09:00:00.000Z', '2022-04-05', [
      ev('pool-joined', {
        drive: ['d0', 'AAA0'],
        slot: ['s0', 'Bay 1'],
        pool: pool1,
        payload: { poolRole: 'data' },
      }),
    ]),
    act('pool-edited', '2026-10-07T09:00:00.000Z', null, [ev('pool-created', { pool: pool1 })]),
  ];

  it('is collapsed by default and loads the history only when opened', async () => {
    const calls = twoPools();
    renderApp(<App />, '/pools');
    const tank = await screen.findByRole('region', { name: 'tank' });
    const summary = within(tank).getByText('History');
    expect(summary.closest('details')).not.toHaveAttribute('open');
    expect(calls.some((c) => c.url.includes('/api/pools/p1/history'))).toBe(false);
  });

  it('lists the pool events sorted by the displayed day, with members named from the drive and the bay from the copied label', async () => {
    twoPools({ 'GET /api/pools/p1/history': history });
    renderApp(<App />, '/pools');
    const tank = await screen.findByRole('region', { name: 'tank' });
    await userEvent.click(within(tank).getByText('History'));
    const list = await within(tank).findByRole('list', { name: 'tank history list' });
    const items = within(list).getAllByRole('listitem');
    // The join was dated 2022-04-05 by the user, so it is listed as the oldest, after the pool's creation.
    expect(items.map((i) => i.querySelector('.story-title')!.textContent)).toEqual([
      'AAA0 left the pool',
      'Renamed from old to tank',
      'CCC2 changed role',
      'Pool created',
      'AAA0 joined in Bay 1 as data',
    ]);
    expect(items[2]).toHaveTextContent('data → hot spare');
    // A date the user gave is shown as typed.
    expect(items[4]).toHaveTextContent('2022-04-05');
  });

  it('says so when a pool has no history yet', async () => {
    twoPools({ 'GET /api/pools/p2/history': [] });
    renderApp(<App />, '/pools');
    const scratch = await screen.findByRole('region', { name: 'scratch' });
    await userEvent.click(within(scratch).getByText('History'));
    expect(await within(scratch).findByText('No history yet.')).toBeInTheDocument();
  });
});

describe('Pools page (R34, R76)', () => {
  it('R76: Pools sits between Drives and Settings in the navigation', async () => {
    twoPools();
    renderApp(<App />, '/pools');
    const nav = screen.getAllByRole('navigation', { name: 'Main' })[0]!;
    expect(
      within(nav)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Layout', 'Drives', 'Pools', 'Settings']);
    expect(await screen.findByRole('heading', { name: 'Pools' })).toBeInTheDocument();
  });

  it('shows a card per pool with size check and members; Settings no longer lists pools', async () => {
    twoPools();
    renderApp(<App />, '/pools');
    const tank = await screen.findByRole('region', { name: 'tank' });
    expect(within(tank).getByText('raidz2', { exact: false })).toBeInTheDocument();
    expect(await within(tank).findByText('2 of 3 drives — one missing')).toBeInTheDocument();
    const list = await within(tank).findByRole('list', { name: 'tank members' });
    const rows = within(list).getAllByRole('button');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('AAA0');
    expect(rows[0]).toHaveTextContent('4 TB');
    expect(rows[0]).toHaveTextContent('Bay 1');
    expect(rows[0]).toHaveTextContent('Data');
    expect(rows[1]).toHaveTextContent('Hot spare');
    const scratch = screen.getByRole('region', { name: 'scratch' });
    expect(within(scratch).getByText('0 members')).toBeInTheDocument();
    expect(await within(scratch).findByText('No drives in this pool.')).toBeInTheDocument();
  });

  it('R12: a pool with members shows its smallest member and how many spares fit', async () => {
    const big = pool('p1', 'big', { memberCount: 3, smallestMemberBytes: 2e12, sparesFit: 3 });
    const one = pool('p2', 'one', { memberCount: 1, smallestMemberBytes: 4e12, sparesFit: 1 });
    const none = pool('p3', 'empty');
    setupServer({
      'GET /api/pools': [big, one, none],
      'GET /api/pools/p1': { ...big, members: [] },
      'GET /api/pools/p2': { ...one, members: [] },
      'GET /api/pools/p3': { ...none, members: [] },
    });
    renderApp(<App />, '/pools');
    const card = await screen.findByRole('region', { name: 'big' });
    expect(within(card).getByText('Smallest member 2 TB · 3 spares fit')).toBeInTheDocument();
    const single = screen.getByRole('region', { name: 'one' });
    expect(within(single).getByText('Smallest member 4 TB · 1 spare fits')).toBeInTheDocument();
    const empty = screen.getByRole('region', { name: 'empty' });
    expect(within(empty).queryByText(/Smallest member/)).not.toBeInTheDocument();
  });

  it('warns about too many drives and stays quiet without an expected size', async () => {
    const big = pool('p1', 'big', { expectedMembers: 1, memberCount: 2, sizeCheck: 'more' });
    setupServer({
      'GET /api/pools': [big],
      'GET /api/pools/p1': { ...big, members: [member('d0', 'AAA0'), member('d2', 'CCC2')] },
    });
    renderApp(<App />, '/pools');
    expect(await screen.findByText('2 drives, expected 1')).toBeInTheDocument();
  });

  it('clicking a member opens the drive detail', async () => {
    twoPools();
    renderApp(<App />, '/pools');
    const tank = await screen.findByRole('region', { name: 'tank' });
    await userEvent.click(await within(tank).findByRole('button', { name: /AAA0/ }));
    const drawer = await screen.findByRole('dialog', { name: 'Drive' });
    expect(await within(drawer).findByText('AAA0')).toBeInTheDocument();
  });

  it('R30, R34: creates a pool with an expected drive count', async () => {
    const calls = twoPools();
    renderApp(<App />, '/pools');
    await userEvent.click(await screen.findByRole('button', { name: 'New pool' }));
    const form = await screen.findByRole('dialog', { name: 'New pool' });
    await userEvent.type(within(form).getByLabelText(/^Name/), 'vault');
    await userEvent.type(within(form).getByLabelText('Expected drives'), '6');
    await userEvent.click(within(form).getByRole('button', { name: 'Create pool' }));
    await waitFor(() => expect(posts(calls, '/api/pools')).toHaveLength(1));
    expect(posts(calls, '/api/pools')[0]!.body).toEqual({
      name: 'vault',
      layoutLabel: null,
      expectedMembers: 6,
    });
  });

  it('R34: editing sends the expected count and can clear it', async () => {
    const calls = twoPools();
    renderApp(<App />, '/pools');
    await userEvent.click(await screen.findByRole('button', { name: 'Edit tank' }));
    const form = await screen.findByRole('dialog', { name: 'Edit tank' });
    const expected = within(form).getByLabelText('Expected drives');
    expect(expected).toHaveValue('3');
    await userEvent.clear(expected);
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      name: 'tank',
      layoutLabel: 'raidz2',
      expectedMembers: null,
    });
  });

  it('R29: shows the 409 message when delete is refused', async () => {
    twoPools();
    setupServer({
      'GET /api/pools': [pool('p1', 'tank')],
      'GET /api/pools/p1': { ...pool('p1', 'tank'), members: [] },
      'DELETE /api/pools/p1': () =>
        errorResponse(
          409,
          'conflict',
          'Pool p1 still has drives installed in it and cannot be deleted',
        ),
    });
    renderApp(<App />, '/pools');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete tank' }));
    const dlg = await screen.findByRole('dialog', { name: 'Delete tank' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Delete pool' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent(/cannot be deleted/);
  });

  it('Settings no longer has a Pools section', async () => {
    twoPools();
    renderApp(<App />, '/settings');
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Pools' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New pool' })).not.toBeInTheDocument();
  });
});
