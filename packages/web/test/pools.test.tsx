import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from './user';
import { App } from '../src/App';
import { sizeCheckText } from '../src/lib/poolSize';
import { errorResponse, posts, setupServer, T } from './server';
import { drive, makeEvent } from './events';
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
  ...over,
});

const member = (driveId: string, serial: string, over: Record<string, unknown> = {}) => ({
  membershipId: `m-${driveId}`,
  driveId,
  serial,
  capacityBytes: 4e12,
  role: 'data',
  startedAt: T,
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

describe('Pool history on the card (events linked to the pool)', () => {
  const poolLink = [{ poolId: 'p1', poolName: 'tank' }];
  const history = [
    makeEvent(
      'pool-left',
      '2026-10-11T09:00:00.000Z',
      { role: 'data' },
      { drives: [drive('d0', 'AAA0')], pools: poolLink },
    ),
    makeEvent(
      'pool-updated',
      '2026-10-10T09:00:00.000Z',
      { name: 'tank', changes: { name: { from: 'old', to: 'tank' } } },
      { drives: [], pools: poolLink },
    ),
    makeEvent(
      'pool-role-changed',
      '2026-10-09T09:00:00.000Z',
      { from: 'data', to: 'hot-spare' },
      { drives: [drive('d2', 'CCC2')], pools: poolLink },
    ),
    makeEvent(
      'pool-joined',
      '2026-10-08T09:00:00.000Z',
      { role: 'data', startedAt: '2022-04-05T00:00:00.000Z' },
      { drives: [drive('d0', 'AAA0')], pools: poolLink },
    ),
    makeEvent('pool-created', '2026-10-07T09:00:00.000Z', {}, { drives: [], pools: poolLink }),
  ];

  it('is collapsed by default and loads the history only when opened', async () => {
    const calls = twoPools();
    renderApp(<App />, '/pools');
    const tank = await screen.findByRole('region', { name: 'tank' });
    const summary = within(tank).getByText('History');
    expect(summary.closest('details')).not.toHaveAttribute('open');
    expect(calls.some((c) => c.url.includes('/api/pools/p1/history'))).toBe(false);
  });

  it('lists the pool events newest first with members named from the drive links', async () => {
    twoPools({ 'GET /api/pools/p1/history': history });
    renderApp(<App />, '/pools');
    const tank = await screen.findByRole('region', { name: 'tank' });
    await userEvent.click(within(tank).getByText('History'));
    const list = await within(tank).findByRole('list', { name: 'tank history list' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((i) => i.querySelector('.story-title')!.textContent)).toEqual([
      'AAA0 left',
      'Renamed from old to tank',
      'CCC2 changed role',
      'AAA0 joined as data',
      'Pool created',
    ]);
    expect(items[2]).toHaveTextContent('data → hot spare');
    // A start date the user gave is shown as typed.
    expect(items[3]).toHaveTextContent('2022-04-05');
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
        errorResponse(409, 'conflict', 'Pool p1 has membership history and cannot be deleted'),
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
