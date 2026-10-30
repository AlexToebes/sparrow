import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from './user';
import { App } from '../src/App';
import { errorResponse, fixtureData, posts, setupServer, T } from './server';
import { makeDrive, renderApp } from './utils';

// R78: drives that are not recommended together. Advice only: it warns, it never blocks.

const view = (id: string, serial: string, over: Record<string, unknown> = {}) => ({
  otherDriveId: id,
  serial,
  model: 'Red',
  capacityBytes: 4e12,
  status: 'spare',
  where: null,
  reason: null,
  createdAt: T,
  ...over,
});

/** The Drives page with the installed drive AAA0 (d0) open in the detail panel. */
async function openDetail(extra: Record<string, unknown | ((b: unknown) => Response)> = {}) {
  const calls = setupServer(extra);
  renderApp(<App />, '/drives?drive=d0');
  const section = await screen.findByRole('region', { name: 'Not recommended with' });
  return { calls, section };
}

describe('R78: the "Not recommended with" section of a drive', () => {
  it('lists each pair with the other drive as a link, its details, status and reason', async () => {
    const { section } = await openDetail({
      'GET /api/drives/d0/conflicts': [
        view('d9', 'SPARE9', { reason: 'Same batch', model: 'Big', capacityBytes: 8e12 }),
        view('d2', 'CCC2', { status: 'installed', where: 'Front bays, Bay 3' }),
        view('d7', 'OLD7', { status: 'retired' }),
      ],
    });
    const list = await within(section).findByRole('list');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    const first = items[0]!;
    expect(within(first).getByRole('link', { name: 'SPARE9' })).toHaveAttribute(
      'href',
      '/drives?drive=d9',
    );
    expect(first).toHaveTextContent('Spare');
    expect(first).toHaveTextContent('Big · 8 TB');
    expect(first).toHaveTextContent('Same batch');
    expect(items[1]).toHaveTextContent('Installed');
    expect(items[1]).toHaveTextContent('Front bays, Bay 3');
    expect(items[1]).toHaveTextContent('No reason given');
    expect(items[2]).toHaveTextContent('Retired');
  });

  it('says "None." when there are no pairs, and still offers Add', async () => {
    const { section } = await openDetail({ 'GET /api/drives/d0/conflicts': [] });
    expect(await within(section).findByText('None.')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Add' })).toBeEnabled();
  });

  it('is there for spares and retired drives too', async () => {
    setupServer({ 'GET /api/drives/d9/conflicts': [view('d0', 'AAA0')] });
    renderApp(<App />, '/drives?drive=d9');
    const section = await screen.findByRole('region', { name: 'Not recommended with' });
    expect(await within(section).findByRole('link', { name: 'AAA0' })).toBeInTheDocument();
  });
});

describe('R78: adding a pair from the drive detail', () => {
  const emptyList = { 'GET /api/drives/d0/conflicts': [] };

  async function openAdd(extra: Record<string, unknown | ((b: unknown) => Response)> = {}) {
    const { calls, section } = await openDetail({ ...emptyList, ...extra });
    await userEvent.click(await within(section).findByRole('button', { name: 'Add' }));
    const dlg = await screen.findByRole('dialog', { name: 'Not recommended with' });
    return { calls, dlg };
  }

  it('offers every other drive of any status with search, but not the drive itself or a drive already paired', async () => {
    const { dlg } = await openAdd({
      'GET /api/drives/d0/conflicts': [view('d8', 'SPARE8')],
    });
    expect(within(dlg).getByText(/Step 1 of 2 · Choose the other drive/)).toBeInTheDocument();
    await within(dlg).findByRole('radio', { name: /SPARE9/ });
    const names = within(dlg)
      .getAllByRole('radio')
      .map((c) => c.textContent?.match(/AAA0|CCC2|SPARE9|SPARE8|OLD7/)?.[0]);
    expect(names).toEqual(['CCC2', 'SPARE9', 'OLD7']); // installed, retired and spare; not AAA0, not SPARE8
    expect(within(dlg).getByRole('radio', { name: /OLD7/ })).toHaveTextContent('Retired');
    expect(within(dlg).getByRole('radio', { name: /CCC2/ })).toHaveTextContent('In Front bays');
    await userEvent.type(within(dlg).getByRole('textbox', { name: 'Search drives' }), 'old');
    expect(within(dlg).getAllByRole('radio')).toHaveLength(1);
    expect(within(dlg).getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('a suggestion chip fills the reason, free text is allowed, and one call is made with the pair', async () => {
    const { calls, dlg } = await openAdd({
      'POST /api/drives/d0/conflicts': () =>
        new Response(JSON.stringify(view('d9', 'SPARE9', { reason: 'Same batch' })), {
          status: 201,
        }),
    });
    await userEvent.click(await within(dlg).findByRole('radio', { name: /SPARE9/ }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Next' }));
    expect(within(dlg).getByText(/Step 2 of 2 · Why\? \(optional\)/)).toBeInTheDocument();
    expect(dlg).toHaveTextContent('AAA0 and SPARE9 will be marked as not recommended together');
    const chips = within(dlg).getByRole('group', { name: 'Reason suggestions' });
    expect(
      within(chips)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Same batch', 'Same purchase', 'Same failure history']);
    const reason = within(dlg).getByRole('textbox', { name: /Reason/ });
    await userEvent.click(within(chips).getByRole('button', { name: 'Same purchase' }));
    expect(reason).toHaveValue('Same purchase');
    expect(within(chips).getByRole('button', { name: 'Same purchase' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.type(reason, ' in March'); // free text on top of a suggestion
    expect(posts(calls, '/api/drives/d0/conflicts')).toHaveLength(0);
    await userEvent.click(
      within(dlg).getByRole('button', { name: 'Mark as not recommended together' }),
    );
    await waitFor(() => expect(posts(calls, '/api/drives/d0/conflicts')).toHaveLength(1));
    expect(posts(calls, '/api/drives/d0/conflicts')[0]!.body).toEqual({
      otherDriveId: 'd9',
      reason: 'Same purchase in March',
    });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Not recommended with' })).toBeNull(),
    );
  });

  it('the reason is optional: no text sends null', async () => {
    const { calls, dlg } = await openAdd({
      'POST /api/drives/d0/conflicts': () =>
        new Response(JSON.stringify(view('d9', 'SPARE9')), { status: 201 }),
    });
    await userEvent.click(await within(dlg).findByRole('radio', { name: /SPARE9/ }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Next' }));
    await userEvent.click(
      within(dlg).getByRole('button', { name: 'Mark as not recommended together' }),
    );
    await waitFor(() => expect(posts(calls, '/api/drives/d0/conflicts')).toHaveLength(1));
    expect(posts(calls, '/api/drives/d0/conflicts')[0]!.body).toEqual({
      otherDriveId: 'd9',
      reason: null,
    });
  });

  it('shows the server message when the pair is refused, and keeps the dialog open', async () => {
    const { dlg } = await openAdd({
      'POST /api/drives/d0/conflicts': () =>
        errorResponse(409, 'conflict', 'AAA0 and SPARE9 are already marked as not recommended'),
    });
    await userEvent.click(await within(dlg).findByRole('radio', { name: /SPARE9/ }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Next' }));
    await userEvent.click(
      within(dlg).getByRole('button', { name: 'Mark as not recommended together' }),
    );
    expect(await within(dlg).findByRole('alert')).toHaveTextContent(/already marked/);
    expect(dlg).toBeVisible();
  });

  it('Back returns to the choice of drive with the choice kept', async () => {
    const { dlg } = await openAdd();
    await userEvent.click(await within(dlg).findByRole('radio', { name: /SPARE9/ }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Next' }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Back' }));
    expect(within(dlg).getByRole('radio', { name: /SPARE9/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});

describe('R78: removing a pair', () => {
  it('asks first (the reason is shown) and only then calls DELETE; Cancel calls nothing', async () => {
    const { calls, section } = await openDetail({
      'GET /api/drives/d0/conflicts': [view('d9', 'SPARE9', { reason: 'Same batch' })],
      'DELETE /api/drives/d0/conflicts/d9': () => new Response(null, { status: 204 }),
    });
    await userEvent.click(await within(section).findByRole('button', { name: /^Remove SPARE9/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Remove pairing' });
    expect(dlg).toHaveTextContent('AAA0');
    expect(dlg).toHaveTextContent('SPARE9');
    expect(dlg).toHaveTextContent('Same batch');
    expect(posts(calls, '/api/drives/d0/conflicts/d9')).toHaveLength(0);

    await userEvent.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    expect(posts(calls, '/api/drives/d0/conflicts/d9')).toHaveLength(0);

    await userEvent.click(await within(section).findByRole('button', { name: /^Remove SPARE9/ }));
    await userEvent.click(
      within(await screen.findByRole('dialog', { name: 'Remove pairing' })).getByRole('button', {
        name: 'Remove',
      }),
    );
    await waitFor(() => expect(posts(calls, '/api/drives/d0/conflicts/d9')).toHaveLength(1));
    expect(posts(calls, '/api/drives/d0/conflicts/d9')[0]!.method).toBe('DELETE');
  });
});

describe('R78: the warning on a pool card', () => {
  const pool = (conflicts: unknown[]) => ({
    id: 'p1',
    name: 'tank',
    layoutLabel: 'raidz2',
    expectedMembers: 2,
    createdAt: T,
    updatedAt: T,
    memberCount: 2,
    sizeCheck: 'ok',
    smallestMemberBytes: 4e12,
    sparesFit: 0,
    conflicts,
  });
  const members = [
    {
      driveId: 'd0',
      serial: 'AAA0',
      capacityBytes: 4e12,
      role: 'data',
      installedOn: null,
      slotId: 's0',
      slotLabel: 'Bay 1',
    },
    {
      driveId: 'd2',
      serial: 'CCC2',
      capacityBytes: 4e12,
      role: 'data',
      installedOn: null,
      slotId: 's2',
      slotLabel: 'Bay 3',
    },
  ];

  it('names the pair and the reason, with an icon and words (not colour alone)', async () => {
    const withPair = pool([
      { driveAId: 'd0', serialA: 'AAA0', driveBId: 'd2', serialB: 'CCC2', reason: 'Same batch' },
      { driveAId: 'd0', serialA: 'AAA0', driveBId: 'd9', serialB: 'ZZZ9', reason: null },
    ]);
    setupServer({
      'GET /api/pools': [withPair],
      'GET /api/pools/p1': { ...withPair, members },
    });
    renderApp(<App />, '/pools');
    const tank = await screen.findByRole('region', { name: 'tank' });
    const warnings = within(tank).getByRole('list', { name: 'tank warnings' });
    const items = within(warnings).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'AAA0 and CCC2 are not recommended together (same batch)',
      'AAA0 and ZZZ9 are not recommended together',
    ]);
    expect(items[0]!.querySelector('svg')).not.toBeNull();
  });

  it('shows nothing when no two members are paired', async () => {
    const clean = pool([]);
    setupServer({ 'GET /api/pools': [clean], 'GET /api/pools/p1': { ...clean, members } });
    renderApp(<App />, '/pools');
    const tank = await screen.findByRole('region', { name: 'tank' });
    await within(tank).findByRole('list', { name: 'tank members' });
    expect(within(tank).queryByRole('list', { name: 'tank warnings' })).toBeNull();
  });
});

describe('R78, R12: the warning on a spare card', () => {
  async function openPicker(
    conflicts: Record<string, { driveId: string; serial: string; reason: string | null }[]>,
  ) {
    const { slots, drives } = fixtureData();
    const all = [
      ...drives,
      makeDrive({ id: 'n1', serial: 'SPARE1', status: 'spare', capacityBytes: 4e12 }),
    ];
    const fit = (id: string) => ({
      driveId: id,
      verdict: 'fits',
      reason: 'ok',
      neededBytes: null,
      conflicts: conflicts[id] ?? [],
    });
    setupServer(
      {
        'GET /api/drives?status=spare': all.filter((d) => d.status === 'spare'),
        'GET /api/slots/s1/compatibility': {
          slotId: 's1',
          target: {
            driveType: 'HDD',
            sizeBytes: 4e12,
            basis: 'pool',
            poolName: 'tank',
            serial: 'X',
          },
          spares: [fit('d8'), fit('d9'), fit('n1')],
        },
      },
      { slots, drives: all },
    );
    renderApp(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /^Bay 2, Empty/ }));
    const panel = await screen.findByRole('dialog');
    await userEvent.click(await within(panel).findByRole('button', { name: 'Assign a drive' }));
    return screen.findByRole('dialog', { name: 'Assign to a slot' });
  }

  it('adds a separate warning line, sorts the paired spare after the others with the same verdict, and still lets it be chosen', async () => {
    const dlg = await openPicker({
      d8: [{ driveId: 'd2', serial: 'CCC2', reason: 'Same batch' }],
    });
    await within(dlg).findByText('Not recommended with CCC2: same batch');
    const cards = within(dlg).getAllByRole('radio');
    // All three fit; the closest size comes first, but the paired SPARE8 goes last of the equals.
    expect(cards.map((c) => c.textContent?.match(/SPARE\d/)?.[0])).toEqual([
      'SPARE1',
      'SPARE9',
      'SPARE8',
    ]);
    const paired = within(dlg).getByRole('radio', { name: /SPARE8/ });
    expect(within(paired).getByText('Fits')).toBeInTheDocument(); // the verdict is unchanged
    expect(
      within(paired)
        .getByText(/Not recommended with CCC2/)
        .querySelector('svg'),
    ).not.toBeNull();
    expect(
      within(within(dlg).getByRole('radio', { name: /SPARE9/ })).queryByText(/Not recommended/),
    ).toBeNull();
    await userEvent.click(paired);
    expect(within(dlg).getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('lists one line per member and words a missing reason', async () => {
    const dlg = await openPicker({
      d9: [
        { driveId: 'd0', serial: 'AAA0', reason: null },
        { driveId: 'd2', serial: 'CCC2', reason: 'Same purchase' },
      ],
    });
    const card = await within(dlg).findByRole('radio', { name: /SPARE9/ });
    expect(within(card).getByText('Not recommended with AAA0')).toBeInTheDocument();
    expect(within(card).getByText('Not recommended with CCC2: same purchase')).toBeInTheDocument();
  });
});
