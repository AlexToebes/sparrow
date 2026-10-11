import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../src/App';
import { makeDrive, makeSlot, next, pickSlot, renderApp } from './utils';

const T = '2026-01-01T00:00:00.000Z';
const recent = new Date(Date.now() - 2 * 60_000).toISOString();

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** Fetch mock that records every call and answers by "METHOD url". Unknown routes are 404. */
function setup(extra: Record<string, unknown | ((body: unknown) => Response)> = {}) {
  const calls: Call[] = [];
  const slots = [
    makeSlot({ id: 's0', position: 0, label: 'Bay 1', driveId: 'd0' }),
    makeSlot({ id: 's1', position: 1, label: 'Bay 2' }),
  ];
  const drives = [
    makeDrive({ id: 'd0', serial: 'AAA0', slotId: 's0', capacityBytes: 4e12 }),
    makeDrive({ id: 'd9', serial: 'SPARE9', status: 'spare', capacityBytes: 8e12, model: 'Big' }),
    makeDrive({
      id: 'd7',
      serial: 'OLD7',
      status: 'retired',
      retirementReason: 'failed',
      retirementDate: '2025-05-05',
    }),
  ];
  const routes: Record<string, unknown | ((body: unknown) => Response)> = {
    'GET /api/layout': {
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
              rows: 1,
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
    'GET /api/drives': drives,
    'GET /api/drives?status=spare': [drives[1]],
    'GET /api/inbox': { entries: [], unidentified: [], retiredCandidates: [], count: 0 },
    'GET /api/provider/status': {
      providerId: 'none',
      reachable: true,
      lastSuccessAt: recent,
      lastAttemptAt: recent,
      lastError: null,
      observationCount: 0,
    },
    'GET /api/status': {
      providerId: 'none',
      providerStale: false,
      staleAfterHours: 36,
      lastSuccessAt: null,
      slots: [],
    },
    'GET /api/pools': [
      { id: 'p1', name: 'tank', layoutLabel: 'raidz2', createdAt: T, updatedAt: T, memberCount: 0 },
    ],
    'GET /api/pools/p1': {
      id: 'p1',
      name: 'tank',
      layoutLabel: 'raidz2',
      createdAt: T,
      updatedAt: T,
      memberCount: 0,
      members: [],
    },
    'GET /api/slots/s1/assignment-defaults': {
      poolId: 'p1',
      role: 'hot-spare',
      previousDriveId: 'dx',
    },
    'GET /api/slots/s0/assignment-defaults': { poolId: 'p1', role: 'data', previousDriveId: 'd0' },
    'GET /api/drives/d0/events': [],
    'GET /api/drives/d7/events': [
      {
        id: 'e9',
        driveId: 'd7',
        type: 'pool-joined',
        at: '2025-01-01T00:00:00.000Z',
        payload: { poolId: 'p1', role: 'hot-spare' },
      },
    ],
    'POST /api/drives': drives[1],
    'POST /api/slots/s1/assign': { drive: drives[1] },
    'POST /api/slots/s0/assign': { drive: drives[1], occupant: drives[0] },
    'POST /api/drives/d9/retire': drives[1],
    'POST /api/drives/d7/reinstate': drives[1],
    ...extra,
  };
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const hit = routes[`${method} ${url}`];
    if (typeof hit === 'function') return Promise.resolve((hit as (b: unknown) => Response)(body));
    if (hit !== undefined) {
      return Promise.resolve(
        new Response(JSON.stringify(hit), {
          status: method === 'POST' && url === '/api/drives' ? 201 : 200,
        }),
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({ error: { code: 'not-found', message: `no mock ${method} ${url}` } }),
        {
          status: 404,
        },
      ),
    );
  }) as typeof fetch;
  return calls;
}

const posts = (calls: Call[], url: string) =>
  calls.filter((c) => c.method !== 'GET' && c.url === url);

/** Mantine Selects label both the input and the listbox; the input comes first. */
const field = (root: Pick<typeof screen, 'getAllByLabelText'>, label: string | RegExp) =>
  root.getAllByLabelText(label)[0]!;

async function pick(label: string | RegExp, option: string | RegExp) {
  await userEvent.click(field(screen, label));
  await userEvent.click(await screen.findByRole('option', { name: option, hidden: true }));
}

describe('Drives page (R11, R13)', () => {
  it('lists drives, filters by status and searches by serial or model', async () => {
    setup();
    renderApp(<App />, '/drives');
    expect(await screen.findByText('SPARE9')).toBeInTheDocument();
    expect(screen.getByText('AAA0')).toBeInTheDocument();
    expect(screen.getByText('Front bays, Bay 1')).toBeInTheDocument();
    await userEvent.click(screen.getByText(/^Retired/, { selector: 'label *, label' }));
    expect(screen.queryByText('SPARE9')).not.toBeInTheDocument();
    expect(screen.getByText('OLD7')).toBeInTheDocument();
    await userEvent.click(screen.getByText(/^All/, { selector: 'label *, label' }));
    await userEvent.type(screen.getByLabelText('Search drives'), 'big');
    expect(screen.getByText('SPARE9')).toBeInTheDocument();
    expect(screen.queryByText('AAA0')).not.toBeInTheDocument();
  });

  it('R11: creates a drive, capacity in TB stored as decimal bytes, cleared fields null', async () => {
    const calls = setup();
    renderApp(<App />, '/drives');
    await userEvent.click(await screen.findByRole('button', { name: /Add drive/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Add a drive' });
    await userEvent.type(within(dlg).getByLabelText(/Serial number/), 'NEW123');
    await userEvent.type(within(dlg).getByLabelText('Capacity'), '1.92');
    await userEvent.type(within(dlg).getByLabelText('Storage location'), 'Desk drawer');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Add drive' }));
    await waitFor(() => expect(posts(calls, '/api/drives')).toHaveLength(1));
    expect(posts(calls, '/api/drives')[0]!.body).toEqual({
      serial: 'NEW123',
      model: null,
      capacityBytes: 1_920_000_000_000,
      driveType: null,
      formFactor: null,
      storageLocation: 'Desk drawer',
      condition: null,
      lastTestDate: null,
      purchaseDate: null,
      warrantyExpiry: null,
      vendor: null,
      notes: null,
    });
  });

  it('requires a serial number', async () => {
    const calls = setup();
    renderApp(<App />, '/drives');
    await userEvent.click(await screen.findByRole('button', { name: /Add drive/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Add a drive' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Add drive' }));
    expect(await within(dlg).findByText('Serial number is required.')).toBeInTheDocument();
    expect(posts(calls, '/api/drives')).toHaveLength(0);
  });

  it('R11: editing sends only changed fields, null when cleared', async () => {
    const calls = setup({ 'PATCH /api/drives/d9': makeDrive({ id: 'd9', serial: 'SPARE9' }) });
    renderApp(<App />, '/drives');
    await userEvent.click(await screen.findByText('SPARE9'));
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const dlg = await screen.findByRole('dialog', { name: 'Edit SPARE9' });
    await userEvent.clear(within(dlg).getByLabelText('Model'));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts(calls, '/api/drives/d9')).toHaveLength(1));
    expect(posts(calls, '/api/drives/d9')[0]!.body).toEqual({ model: null });
  });
});

describe('Assignment (R8, R35, R37, R62)', () => {
  it('R35: assign from the spares shelf prefills pool and role from the slot defaults', async () => {
    const calls = setup();
    renderApp(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Assign SPARE9' }));
    const dlg = await screen.findByRole('dialog', { name: 'Assign to a slot' });
    await pickSlot(within(dlg), /Bay 2, empty/);
    await next(within(dlg));
    await waitFor(() => expect(field(within(dlg), 'Pool')).toHaveValue('tank · raidz2'));
    expect(field(within(dlg), 'Role')).toHaveValue('Hot spare');
    await next(within(dlg));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(posts(calls, '/api/slots/s1/assign')).toHaveLength(1));
    expect(posts(calls, '/api/slots/s1/assign')[0]!.body).toEqual({
      driveId: 'd9',
      poolId: 'p1',
      role: 'hot-spare',
      installedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), // moving a spare in now: today
    });
  });

  it('R68: the assign dialog defaults "Installed on" to today and sends a chosen past date', async () => {
    const calls = setup();
    renderApp(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Assign SPARE9' }));
    const dlg = await screen.findByRole('dialog', { name: 'Assign to a slot' });
    await pickSlot(within(dlg), /Bay 2, empty/);
    await next(within(dlg));
    const date = within(dlg).getByLabelText('Installed on (optional)');
    expect(date).toHaveAttribute('type', 'date');
    expect((date as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(date).toHaveAttribute('max', (date as HTMLInputElement).value);
    expect(
      within(dlg).getByText(
        'Leave empty if you don’t know — it’s better to show ‘not recorded’ than a guess.',
      ),
    ).toBeInTheDocument();
    fireEvent.change(date, { target: { value: '2023-05-06' } });
    await next(within(dlg));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(posts(calls, '/api/slots/s1/assign')).toHaveLength(1));
    expect(posts(calls, '/api/slots/s1/assign')[0]!.body).toMatchObject({
      driveId: 'd9',
      installedOn: '2023-05-06',
    });
  });

  it('R68: Clear empties the field and an explicit null ("not recorded") is sent; Today refills it', async () => {
    const calls = setup();
    renderApp(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Assign SPARE9' }));
    const dlg = await screen.findByRole('dialog', { name: 'Assign to a slot' });
    await pickSlot(within(dlg), /Bay 2, empty/);
    await next(within(dlg));
    const date = within(dlg).getByLabelText('Installed on (optional)');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Clear' }));
    expect(date).toHaveValue('');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Today' }));
    expect((date as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Clear' }));
    await next(within(dlg));
    expect(within(dlg).getByText(/Install date: not recorded/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(posts(calls, '/api/slots/s1/assign')).toHaveLength(1));
    expect(posts(calls, '/api/slots/s1/assign')[0]!.body).toMatchObject({
      driveId: 'd9',
      installedOn: null,
    });
  });

  it('R68: a future installation date is refused before anything is sent', async () => {
    const calls = setup();
    renderApp(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Assign SPARE9' }));
    const dlg = await screen.findByRole('dialog', { name: 'Assign to a slot' });
    await pickSlot(within(dlg), /Bay 2, empty/);
    await next(within(dlg));
    fireEvent.change(within(dlg).getByLabelText('Installed on (optional)'), {
      target: { value: '2999-01-01' },
    });
    await next(within(dlg));
    expect(await within(dlg).findByText(/cannot be in the future/)).toBeInTheDocument();
    expect(posts(calls, '/api/slots/s1/assign')).toHaveLength(0);
  });

  it('D8: dropdowns open outside the dialog body so it cannot clip them', async () => {
    setup();
    renderApp(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Assign SPARE9' }));
    const dlg = await screen.findByRole('dialog', { name: 'Assign to a slot' });
    await pickSlot(within(dlg), /Bay 2, empty/);
    await next(within(dlg));
    await userEvent.click(field(within(dlg), 'Pool'));
    const option = await screen.findByRole('option', { name: /tank/, hidden: true });
    // Layout is not testable in jsdom; the structural guarantee is that the list lives in a
    // portal on document.body, not inside the (scrolling, clipping) modal content.
    expect(dlg.contains(option)).toBe(false);
    expect(option.closest('.mantine-Popover-dropdown')?.parentElement?.parentElement).toBe(
      document.body,
    );
  });

  it('R8: only spares are offered, never retired or installed drives', async () => {
    setup();
    renderApp(<App />, '/drives');
    await userEvent.click(await screen.findByText('SPARE9'));
    expect(await screen.findByRole('button', { name: 'Assign to slot' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(await screen.findByText('OLD7'));
    expect(screen.queryByRole('button', { name: 'Assign to slot' })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Reinstate' })).toBeInTheDocument();
  });

  it('R37, R62: an occupied slot asks what to do with the occupant, retire prefills replaced-by', async () => {
    const calls = setup();
    renderApp(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Assign SPARE9' }));
    const dlg = await screen.findByRole('dialog', { name: 'Assign to a slot' });
    await pickSlot(within(dlg), /Bay 1, occupied by AAA0/);
    await next(within(dlg));
    const occ = dlg;
    expect(
      await within(occ).findByText('What happens to the drive in this bay?', { exact: false }),
    ).toBeInTheDocument();
    expect(within(occ).getByText('AAA0')).toBeInTheDocument();
    expect(within(occ).getByRole('radio', { name: 'Back to spares' })).toBeInTheDocument();
    expect(within(occ).getByRole('radio', { name: 'Send for RMA' })).toBeInTheDocument();
    await userEvent.click(within(occ).getByRole('radio', { name: /Retire it/ }));
    expect(field(within(occ), /^Reason/)).toHaveValue('Replaced');
    expect(field(within(occ), 'Replaced by')).toHaveValue('SPARE9 · Big · 8 TB (spare)');
    const compare = within(occ).getByLabelText('Capacity comparison');
    expect(within(compare).getByText('4 TB')).toBeInTheDocument();
    expect(within(compare).getByText('8 TB')).toBeInTheDocument();
    await next(within(occ));
    await next(within(occ));
    await userEvent.click(within(occ).getByRole('button', { name: 'Retire it and assign' }));
    await waitFor(() => expect(posts(calls, '/api/slots/s0/assign')).toHaveLength(1));
    expect(posts(calls, '/api/slots/s0/assign')[0]!.body).toMatchObject({
      driveId: 'd9',
      poolId: 'p1',
      role: 'data',
      occupant: {
        action: 'retire',
        reason: 'replaced',
        replacedByDriveId: 'd9',
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      },
    });
  });

  it('R37: back to spares sends occupant action spare', async () => {
    const calls = setup();
    renderApp(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Assign SPARE9' }));
    const dlg = await screen.findByRole('dialog', { name: 'Assign to a slot' });
    await pickSlot(within(dlg), /Bay 1, occupied/);
    await next(within(dlg));
    const occ = dlg;
    await next(within(occ));
    await next(within(occ));
    await userEvent.click(within(occ).getByRole('button', { name: 'Move to spares and assign' }));
    await waitFor(() => expect(posts(calls, '/api/slots/s0/assign')).toHaveLength(1));
    expect(posts(calls, '/api/slots/s0/assign')[0]!.body).toMatchObject({
      occupant: { action: 'spare' },
    });
  });

  it('R37: a 409 with details.occupant (the slot filled meanwhile) opens the resolution step', async () => {
    let first = true;
    const calls = setup({
      'POST /api/slots/s1/assign': () => {
        if (first) {
          first = false;
          return new Response(
            JSON.stringify({
              error: {
                code: 'conflict',
                message: 'Slot Bay 2 is occupied by AAA0',
                details: { occupant: { driveId: 'd0', serial: 'AAA0' } },
              },
            }),
            { status: 409 },
          );
        }
        return new Response(JSON.stringify({ drive: {} }), { status: 200 });
      },
    });
    renderApp(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Assign SPARE9' }));
    const dlg = await screen.findByRole('dialog', { name: 'Assign to a slot' });
    await pickSlot(within(dlg), /Bay 2, empty/);
    await next(within(dlg));
    await next(within(dlg));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Assign' }));
    const occ = dlg;
    expect(
      await within(occ).findByText(/Step 2 of 4 · What happens to the drive/),
    ).toBeInTheDocument();
    expect(within(occ).getByText('AAA0')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
});

describe('Retire and reinstate (R60, R61)', () => {
  it('R60: a retired drive shows its date, or says the date is not recorded', async () => {
    setup();
    renderApp(<App />, '/drives');
    await userEvent.click(await screen.findByText('OLD7'));
    expect(await screen.findByText('failed · 2025-05-05')).toBeInTheDocument();
  });

  it('R60: a retired drive without a date says so', async () => {
    const noDate = makeDrive({
      id: 'd7',
      serial: 'OLD7',
      status: 'retired',
      retirementReason: 'other',
      retirementDate: null,
    });
    setup({ 'GET /api/drives': [noDate], 'GET /api/drives/d7': noDate });
    renderApp(<App />, '/drives');
    await userEvent.click(await screen.findByText('OLD7'));
    expect(await screen.findByText('other · retirement date not recorded')).toBeInTheDocument();
  });

  it('R60, R62: the occupant step takes an optional retirement date; Clear sends null', async () => {
    const calls = setup();
    renderApp(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Assign SPARE9' }));
    const dlg = await screen.findByRole('dialog', { name: 'Assign to a slot' });
    await pickSlot(within(dlg), /Bay 1, occupied by AAA0/);
    await next(within(dlg));
    const occ = dlg;
    expect(
      await within(occ).findByText('What happens to the drive in this bay?', { exact: false }),
    ).toBeInTheDocument();
    await userEvent.click(within(occ).getByRole('radio', { name: /Retire it/ }));
    await userEvent.click(within(occ).getByRole('button', { name: 'Clear' }));
    await next(within(occ));
    await next(within(occ));
    await userEvent.click(within(occ).getByRole('button', { name: 'Retire it and assign' }));
    await waitFor(() => expect(posts(calls, '/api/slots/s0/assign')).toHaveLength(1));
    expect(posts(calls, '/api/slots/s0/assign')[0]!.body).toMatchObject({
      occupant: { action: 'retire', reason: 'replaced', date: null },
    });
  });

  it('R60, R61: retiring a spare with a replacement shows both capacities and confirms before sending', async () => {
    const calls = setup();
    renderApp(<App />, '/drives');
    await userEvent.click(await screen.findByText('SPARE9'));
    await userEvent.click(await screen.findByRole('button', { name: 'Retire' }));
    const dlg = await screen.findByRole('dialog', { name: 'Retire SPARE9' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Review' }));
    expect(await within(dlg).findByText('Choose a reason.')).toBeInTheDocument();
    await pick(/Reason/, 'Failed');
    await pick(/Replaced by/, /AAA0/);
    const compare = within(dlg).getByLabelText('Capacity comparison');
    expect(within(compare).getByText('8 TB')).toBeInTheDocument();
    expect(within(compare).getByText('4 TB')).toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText('Note'), 'clicking noises');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Review' }));
    expect(posts(calls, '/api/drives/d9/retire')).toHaveLength(0);
    await userEvent.click(await within(dlg).findByRole('button', { name: 'Confirm retire' }));
    await waitFor(() => expect(posts(calls, '/api/drives/d9/retire')).toHaveLength(1));
    expect(posts(calls, '/api/drives/d9/retire')[0]!.body).toEqual({
      reason: 'failed',
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      replacedByDriveId: 'd0',
      note: 'clicking noises',
    });
  });

  it('R60: the retirement date is optional: Clear sends null, the reason is still required', async () => {
    const calls = setup();
    renderApp(<App />, '/drives');
    await userEvent.click(await screen.findByText('SPARE9'));
    await userEvent.click(await screen.findByRole('button', { name: 'Retire' }));
    const dlg = await screen.findByRole('dialog', { name: 'Retire SPARE9' });
    const date = within(dlg).getByLabelText(/Retirement date \(optional\)/);
    expect((date as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(within(dlg).getByText(/better ‘not recorded’ than a guess/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Clear' }));
    expect(date).toHaveValue('');
    // No reason yet: still blocked.
    await userEvent.click(within(dlg).getByRole('button', { name: 'Review' }));
    expect(await within(dlg).findByText('Choose a reason.')).toBeInTheDocument();
    await pick(/Reason/, 'Failed');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Review' }));
    expect(await within(dlg).findByText(/retirement date not recorded/)).toBeInTheDocument();
    await userEvent.click(await within(dlg).findByRole('button', { name: 'Confirm retire' }));
    await waitFor(() => expect(posts(calls, '/api/drives/d9/retire')).toHaveLength(1));
    expect(posts(calls, '/api/drives/d9/retire')[0]!.body).toMatchObject({
      reason: 'failed',
      date: null,
    });
  });

  it('shows the API error readably when retiring fails', async () => {
    setup({
      'POST /api/drives/d9/retire': () =>
        new Response(
          JSON.stringify({
            error: { code: 'invalid', message: 'Replacement chain would loop back' },
          }),
          {
            status: 400,
          },
        ),
    });
    renderApp(<App />, '/drives');
    await userEvent.click(await screen.findByText('SPARE9'));
    await userEvent.click(await screen.findByRole('button', { name: 'Retire' }));
    const dlg = await screen.findByRole('dialog', { name: 'Retire SPARE9' });
    await pick(/Reason/, 'Other');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Review' }));
    await userEvent.click(await within(dlg).findByRole('button', { name: 'Confirm retire' }));
    expect(await within(dlg).findByText('Replacement chain would loop back')).toBeInTheDocument();
  });

  it('R13: reinstating a retired drive confirms, then posts', async () => {
    const calls = setup();
    renderApp(<App />, '/drives');
    await userEvent.click(await screen.findByText('OLD7'));
    await userEvent.click(await screen.findByRole('button', { name: 'Reinstate' }));
    const dlg = await screen.findByRole('dialog', { name: 'Reinstate drive' });
    expect(posts(calls, '/api/drives/d7/reinstate')).toHaveLength(0);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Reinstate as spare' }));
    await waitFor(() => expect(posts(calls, '/api/drives/d7/reinstate')).toHaveLength(1));
    expect(posts(calls, '/api/drives/d7/reinstate')[0]!.body).toEqual({});
  });

  it('life story names the pool and role for pool events', async () => {
    setup();
    renderApp(<App />, '/drives');
    await userEvent.click(await screen.findByText('OLD7'));
    expect(await screen.findByText('Joined pool tank')).toBeInTheDocument();
    expect(screen.getByText('hot spare')).toBeInTheDocument();
  });
});

describe('Installation date on the drive detail (R68)', () => {
  it('shows the date for an installed drive and saves an edit through PATCH', async () => {
    const calls = setup({
      'PATCH /api/drives/d0': makeDrive({
        id: 'd0',
        serial: 'AAA0',
        slotId: 's0',
        installedOn: '2021-02-03',
      }),
    });
    renderApp(<App />, '/drives');
    await userEvent.click(await screen.findByText('AAA0'));
    const row = (await screen.findByText('Installed on')).closest('dt')!;
    expect(row.nextElementSibling).toHaveTextContent('2026-01-01');
    await userEvent.click(screen.getByRole('button', { name: 'Edit installation date' }));
    const dlg = await screen.findByRole('dialog', { name: 'Installation date' });
    fireEvent.change(within(dlg).getByLabelText('Installed on (optional)'), {
      target: { value: '2021-02-03' },
    });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts(calls, '/api/drives/d0')).toHaveLength(1));
    expect(posts(calls, '/api/drives/d0')[0]!.body).toEqual({ installedOn: '2021-02-03' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Installation date' })).not.toBeInTheDocument(),
    );
  });

  it('shows the API error inline and keeps the dialog open', async () => {
    setup({
      'PATCH /api/drives/d0': () =>
        new Response(
          JSON.stringify({
            error: { code: 'invalid', message: 'installedOn must not be in the future' },
          }),
          { status: 400 },
        ),
    });
    renderApp(<App />, '/drives');
    await userEvent.click(await screen.findByText('AAA0'));
    await userEvent.click(await screen.findByRole('button', { name: 'Edit installation date' }));
    const dlg = await screen.findByRole('dialog', { name: 'Installation date' });
    fireEvent.change(within(dlg).getByLabelText('Installed on (optional)'), {
      target: { value: '2020-01-01' },
    });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    expect(
      await within(dlg).findByText('installedOn must not be in the future'),
    ).toBeInTheDocument();
  });

  it('shows "not recorded" with a Set date action, and Clear date sends null', async () => {
    const calls = setup({
      'GET /api/drives/d0/events': [
        {
          id: 'e1',
          driveId: 'd0',
          type: 'drive-installed',
          at: '2026-10-11T09:00:00.000Z',
          payload: { slotLabel: 'Bay 1', installedOn: null },
        },
      ],
      'GET /api/drives': [makeDrive({ id: 'd0', serial: 'AAA0', slotId: 's0', installedOn: null })],
      'PATCH /api/drives/d0': makeDrive({
        id: 'd0',
        serial: 'AAA0',
        slotId: 's0',
        installedOn: null,
      }),
    });
    renderApp(<App />, '/drives');
    await userEvent.click(await screen.findByText('AAA0'));
    const setBtn = await screen.findByRole('button', { name: 'Set installation date' });
    expect(setBtn.closest('dd')).toHaveTextContent('not recorded');
    expect(setBtn.closest('dd')!.previousElementSibling).toHaveTextContent('Installed');
    expect(await screen.findByText('Installation date not recorded')).toBeInTheDocument(); // life story header
    expect(
      screen.getByText('Installed in Bay 1 (installation date not recorded)'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Set installation date' }));
    const dlg = await screen.findByRole('dialog', { name: 'Installation date' });
    expect(within(dlg).getByLabelText('Installed on (optional)')).toHaveValue('');
    expect(within(dlg).queryByRole('button', { name: 'Clear date' })).not.toBeInTheDocument();
    fireEvent.change(within(dlg).getByLabelText('Installed on (optional)'), {
      target: { value: '2020-05-06' },
    });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts(calls, '/api/drives/d0')).toHaveLength(1));
    expect(posts(calls, '/api/drives/d0')[0]!.body).toEqual({ installedOn: '2020-05-06' });
  });

  it('a dated drive offers Clear date, which sends installedOn null', async () => {
    const calls = setup({
      'PATCH /api/drives/d0': makeDrive({
        id: 'd0',
        serial: 'AAA0',
        slotId: 's0',
        installedOn: null,
      }),
    });
    renderApp(<App />, '/drives');
    await userEvent.click(await screen.findByText('AAA0'));
    await userEvent.click(await screen.findByRole('button', { name: 'Edit installation date' }));
    const dlg = await screen.findByRole('dialog', { name: 'Installation date' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Clear date' }));
    await waitFor(() => expect(posts(calls, '/api/drives/d0')).toHaveLength(1));
    expect(posts(calls, '/api/drives/d0')[0]!.body).toEqual({ installedOn: null });
  });

  it('offers no installation date for spares or retired drives', async () => {
    setup();
    renderApp(<App />, '/drives');
    await userEvent.click(await screen.findByText('OLD7'));
    await screen.findByText('Retirement note');
    expect(screen.queryByText('Installed on')).not.toBeInTheDocument();
  });
});
