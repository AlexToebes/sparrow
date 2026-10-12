import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from './user';
import { App } from '../src/App';
import { makeDrive, makeSlot, next, pickSlot, renderApp } from './utils';

const T = '2026-01-01T00:00:00.000Z';
const recent = new Date(Date.now() - 2 * 60_000).toISOString();

interface Call {
  method: string;
  url: string;
  body: unknown;
}
type Handler = unknown | ((body: unknown) => Response);

const obs = (serial: string, over = {}) => ({
  serial,
  model: 'NX4',
  capacityBytes: 4e12,
  driveType: 'HDD',
  health: 'ok',
  lastReportedAt: recent,
  state: 'active',
  ...over,
});

const spare = makeDrive({ id: 'sp1', serial: 'SPARE1', status: 'spare', model: 'NX4' });
const installed = makeDrive({ id: 'd0', serial: 'AAA0', slotId: 's0' });

function setup(extra: Record<string, Handler> = {}, inbox: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const routes: Record<string, Handler> = {
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
              slots: [
                makeSlot({ id: 's0', position: 0, label: 'Bay 1', driveId: 'd0' }),
                makeSlot({ id: 's1', position: 1, label: 'Bay 2' }),
              ],
            },
          ],
        },
      ],
    },
    'GET /api/drives': [installed, spare],
    'GET /api/drives?status=spare': [spare],
    'GET /api/inbox': {
      entries: [],
      unidentified: [],
      retiredCandidates: [],
      count: 0,
      ...inbox,
    },
    'GET /api/provider/status': {
      providerId: 'scrutiny',
      reachable: true,
      lastSuccessAt: recent,
      lastAttemptAt: recent,
      lastError: null,
      observationCount: 1,
    },
    'GET /api/status': {
      providerId: 'scrutiny',
      providerStale: false,
      staleAfterHours: 36,
      lastSuccessAt: recent,
      slots: [],
    },
    'GET /api/pools': [
      {
        id: 'p1',
        name: 'tank',
        layoutLabel: 'raidz2',
        expectedMembers: null,
        createdAt: T,
        updatedAt: T,
        memberCount: 1,
        sizeCheck: null,
      },
    ],
    'GET /api/pools/p1': {
      id: 'p1',
      name: 'tank',
      layoutLabel: 'raidz2',
      expectedMembers: null,
      createdAt: T,
      updatedAt: T,
      memberCount: 1,
      sizeCheck: null,
      members: [],
    },
    'GET /api/slots/s0/assignment-defaults': { poolId: 'p1', role: 'data', previousDriveId: null },
    'GET /api/slots/s1/assignment-defaults': { poolId: 'p1', role: 'data', previousDriveId: null },
    'GET /api/drives/d0/history': [],
    ...extra,
  };
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const hit = routes[`${method} ${url}`];
    if (typeof hit === 'function') return Promise.resolve((hit as (b: unknown) => Response)(body));
    if (hit !== undefined) return Promise.resolve(new Response(JSON.stringify(hit)));
    return Promise.resolve(
      new Response(
        JSON.stringify({ error: { code: 'not-found', message: `no mock ${method} ${url}` } }),
        { status: 404 },
      ),
    );
  }) as typeof fetch;
  return calls;
}

const posts = (calls: Call[], url: string) =>
  calls.filter((c) => c.method !== 'GET' && c.url === url);
const field = (root: Pick<typeof screen, 'getAllByLabelText'>, label: string | RegExp) =>
  root.getAllByLabelText(label)[0]!;
async function pick(
  root: Pick<typeof screen, 'getAllByLabelText'>,
  label: string | RegExp,
  option: string | RegExp,
) {
  const input = field(root, label);
  await userEvent.click(input);
  // Dropdowns render inline and stay in the DOM, so scope the option to this input's own listbox.
  const listbox = document.getElementById(input.getAttribute('aria-controls')!)!;
  await userEvent.click(await within(listbox).findByRole('option', { name: option, hidden: true }));
}

describe('Inbox (R22, R23, R25, R58)', () => {
  it('R25: shows the suggestion, links only after the slot step is confirmed', async () => {
    const calls = setup(
      { 'POST /api/inbox/ABC%2F1/link': { drive: spare } },
      {
        entries: [{ observationKey: 'ABC/1', observation: obs('SPARE-1'), suggestion: spare }],
        count: 1,
      },
    );
    renderApp(<App />, '/drives/discovered');
    const card = await screen.findByRole('article', { name: 'Discovered drive SPARE-1' });
    expect(within(card).getByText(/Looks like spare/)).toBeInTheDocument();
    expect(posts(calls, '/api/inbox/ABC%2F1/link')).toHaveLength(0);
    await userEvent.click(within(card).getByRole('button', { name: 'Link to SPARE1' }));
    const dlg = await screen.findByRole('dialog', { name: 'Assign to a slot' });
    expect(within(dlg).getByText(/Step 1 of 3 · Choose the slot/)).toBeInTheDocument();
    await pickSlot(within(dlg), /Bay 2, empty/);
    await next(within(dlg));
    await waitFor(() => expect(field(within(dlg), 'Pool')).toHaveValue('tank · raidz2'));
    await next(within(dlg));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(posts(calls, '/api/inbox/ABC%2F1/link')).toHaveLength(1));
    expect(posts(calls, '/api/inbox/ABC%2F1/link')[0]!.body).toEqual({
      driveId: 'sp1',
      slotId: 's1',
      poolId: 'p1',
      role: 'data',
    });
  });

  it('R22: link to a spare without a suggestion uses a picker of spares', async () => {
    const calls = setup(
      { 'POST /api/inbox/X1/link': { drive: spare } },
      {
        entries: [{ observationKey: 'X1', observation: obs('NEW-1'), suggestion: null }],
        count: 1,
      },
    );
    renderApp(<App />, '/drives/discovered');
    await userEvent.click(await screen.findByRole('button', { name: 'Link to a spare' }));
    const pickDlg = await screen.findByRole('dialog', { name: 'Link NEW-1 to a spare' });
    expect(within(pickDlg).getByRole('button', { name: 'Next' })).toBeDisabled();
    // F9: the same card picker as the Assign dialog, not a dropdown.
    await userEvent.click(await within(pickDlg).findByRole('radio', { name: /SPARE1/ }));
    await userEvent.click(within(pickDlg).getByRole('button', { name: 'Next' }));
    const dlg = await screen.findByRole('dialog', { name: 'Assign to a slot' });
    expect(within(dlg).getByText(/Step 1 of 3 · Choose the slot/)).toBeInTheDocument();
    await pickSlot(within(dlg), /Bay 2, empty/);
    await next(within(dlg));
    await waitFor(() => expect(field(within(dlg), 'Pool')).toHaveValue('tank · raidz2'));
    await next(within(dlg));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(posts(calls, '/api/inbox/X1/link')).toHaveLength(1));
  });

  it('R22, R23, R37: create from observation continues to slot, pool and role, with occupant resolution', async () => {
    const calls = setup(
      { 'POST /api/inbox/X2/create': { drive: spare, occupant: installed } },
      {
        entries: [{ observationKey: 'X2', observation: obs('NEW-2'), suggestion: null }],
        count: 1,
      },
    );
    renderApp(<App />, '/drives/discovered');
    await userEvent.click(await screen.findByRole('button', { name: 'Create new record' }));
    const dlg = await screen.findByRole('dialog', { name: 'Assign to a slot' });
    await pickSlot(within(dlg), /Bay 1, occupied by AAA0/);
    await next(within(dlg));
    const occ = dlg;
    expect(within(occ).getByText(/Step 2 of 4 · What happens to the drive/)).toBeInTheDocument();
    await next(within(occ));
    await next(within(occ));
    await userEvent.click(within(occ).getByRole('button', { name: 'Move to spares and assign' }));
    await waitFor(() => expect(posts(calls, '/api/inbox/X2/create')).toHaveLength(1));
    expect(posts(calls, '/api/inbox/X2/create')[0]!.body).toEqual({
      slotId: 's0',
      poolId: 'p1',
      role: 'data',
      // R69: the occupant leaves today unless the date is changed or cleared.
      occupant: { action: 'spare', removedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
    });
  });

  it('R68: the inbox create flow can backdate the installation (drive in the NAS before Sparrow)', async () => {
    const calls = setup(
      { 'POST /api/inbox/X2/create': { drive: spare } },
      {
        entries: [{ observationKey: 'X2', observation: obs('NEW-2'), suggestion: null }],
        count: 1,
      },
    );
    renderApp(<App />, '/drives/discovered');
    await userEvent.click(await screen.findByRole('button', { name: 'Create new record' }));
    const dlg = await screen.findByRole('dialog', { name: 'Assign to a slot' });
    await pickSlot(within(dlg), /Bay 2, empty/);
    await next(within(dlg));
    fireEvent.change(within(dlg).getByLabelText('Installed on (optional)'), {
      target: { value: '2022-03-04' },
    });
    await next(within(dlg));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(posts(calls, '/api/inbox/X2/create')).toHaveLength(1));
    expect(posts(calls, '/api/inbox/X2/create')[0]!.body).toMatchObject({
      slotId: 's1',
      installedOn: '2022-03-04',
    });
  });

  it('R68: in the inbox flow "Installed on" starts empty and nothing is sent unless filled in', async () => {
    const calls = setup(
      { 'POST /api/inbox/X2/create': { drive: spare } },
      {
        entries: [{ observationKey: 'X2', observation: obs('NEW-2'), suggestion: null }],
        count: 1,
      },
    );
    renderApp(<App />, '/drives/discovered');
    await userEvent.click(await screen.findByRole('button', { name: 'Create new record' }));
    const dlg = await screen.findByRole('dialog', { name: 'Assign to a slot' });
    await pickSlot(within(dlg), /Bay 2, empty/);
    await next(within(dlg));
    const date = within(dlg).getByLabelText('Installed on (optional)');
    expect(date).toHaveValue('');
    expect(
      within(dlg).getByText(/it’s better to show ‘not recorded’ than a guess/),
    ).toBeInTheDocument();
    await next(within(dlg));
    expect(within(dlg).getByText(/Install date: not recorded/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(posts(calls, '/api/inbox/X2/create')).toHaveLength(1));
    expect(posts(calls, '/api/inbox/X2/create')[0]!.body).not.toHaveProperty('installedOn');
  });

  it('R24: first run (no drives) shows the intro; R58: unidentified is informational only', async () => {
    setup(
      { 'GET /api/drives': [] },
      {
        entries: [{ observationKey: 'X3', observation: obs('NEW-3'), suggestion: null }],
        unidentified: [obs(undefined as unknown as string, { serial: undefined, model: 'Ghost' })],
        count: 1,
      },
    );
    renderApp(<App />, '/drives/discovered');
    expect(await screen.findByText('Welcome to Sparrow')).toBeInTheDocument();
    const un = await screen.findByRole('region', { name: 'Unidentified' });
    expect(within(un).getByText(/Ghost/)).toBeInTheDocument();
    expect(within(un).getByText(/cannot be linked/)).toBeInTheDocument();
    expect(within(un).queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('Import retired drives (R63)', () => {
  const retired = [
    {
      observationKey: 'R1',
      serial: 'RET-1',
      model: 'Old',
      capacityBytes: 2e12,
      driveType: 'HDD',
      retirementDate: '2024-03-04',
      healthHint: 'failed',
    },
    {
      observationKey: 'R/2',
      serial: 'RET-2',
      model: 'Old',
      capacityBytes: 2e12,
      driveType: 'HDD',
      retirementDate: '2024-05-06',
      healthHint: 'ok',
    },
  ];

  it('bulk reason, disabled until every selected row has one, confirm, then posts', async () => {
    const calls = setup(
      { 'POST /api/inbox/import-retired': [spare] },
      { retiredCandidates: retired },
    );
    renderApp(<App />, '/drives/discovered');
    await userEvent.click(await screen.findByRole('button', { name: 'Review 2' }));
    const panel = await screen.findByRole('region', { name: 'Import retired drives' });
    const submit = within(panel).getByRole('button', { name: /^Import/ });
    expect(submit).toBeDisabled();
    // Health is only a hint, and the date is prefilled from retirementDate.
    expect(within(panel).getByLabelText('Date for RET-1')).toHaveValue('2024-03-04');
    expect(field(within(panel), 'Reason for RET-1')).toHaveValue('');

    await userEvent.click(within(panel).getByLabelText('Select RET-1'));
    await userEvent.click(within(panel).getByLabelText('Select RET-2'));
    expect(submit).toBeDisabled();
    await pick(within(panel), 'Reason for selected drives', 'Failed');
    await userEvent.click(within(panel).getByRole('button', { name: 'Apply reason to selected' }));
    await waitFor(() => expect(submit).toBeEnabled());
    // Override one row; an edited date is sent.
    await pick(within(panel), 'Reason for RET-2', 'Other');
    await userEvent.clear(within(panel).getByLabelText('Date for RET-2'));
    await userEvent.type(within(panel).getByLabelText('Date for RET-2'), '2024-06-07');
    await userEvent.click(submit);
    expect(posts(calls, '/api/inbox/import-retired')).toHaveLength(0);
    const dlg = await screen.findByRole('dialog', { name: 'Import retired drives' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Import 2' }));
    await waitFor(() => expect(posts(calls, '/api/inbox/import-retired')).toHaveLength(1));
    expect(posts(calls, '/api/inbox/import-retired')[0]!.body).toEqual({
      items: [
        { observationKey: 'R1', reason: 'failed', date: '2024-03-04' },
        { observationKey: 'R/2', reason: 'other', date: '2024-06-07' },
      ],
    });
  });

  it('R63, R60: a cleared date is allowed and sent as null; only a missing reason blocks the import', async () => {
    const calls = setup(
      { 'POST /api/inbox/import-retired': [spare] },
      { retiredCandidates: retired },
    );
    renderApp(<App />, '/drives/discovered');
    await userEvent.click(await screen.findByRole('button', { name: 'Review 2' }));
    const panel = await screen.findByRole('region', { name: 'Import retired drives' });
    await userEvent.click(within(panel).getByLabelText('Select RET-1'));
    await pick(within(panel), 'Reason for RET-1', 'Failed');
    await userEvent.click(within(panel).getByRole('button', { name: 'Clear date for RET-1' }));
    expect(within(panel).getByLabelText('Date for RET-1')).toHaveValue('');
    expect(within(panel).getByText('Not recorded')).toBeInTheDocument();
    const submit = within(panel).getByRole('button', { name: /^Import/ });
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    const dlg = await screen.findByRole('dialog', { name: 'Import retired drives' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Import 1' }));
    await waitFor(() => expect(posts(calls, '/api/inbox/import-retired')).toHaveLength(1));
    expect(posts(calls, '/api/inbox/import-retired')[0]!.body).toEqual({
      items: [{ observationKey: 'R1', reason: 'failed', date: null }],
    });
  });

  it('stays disabled when a selected row has no reason', async () => {
    setup({}, { retiredCandidates: retired });
    renderApp(<App />, '/drives/discovered');
    await userEvent.click(await screen.findByRole('button', { name: 'Review 2' }));
    const panel = await screen.findByRole('region', { name: 'Import retired drives' });
    await userEvent.click(within(panel).getByLabelText('Select RET-1'));
    await pick(within(panel), 'Reason for RET-1', 'Failed');
    await userEvent.click(within(panel).getByLabelText('Select RET-2'));
    expect(within(panel).getByRole('button', { name: /^Import/ })).toBeDisabled();
    expect(within(panel).getByText(/needs a reason/)).toBeInTheDocument();
  });
});

describe('Missing drive (R27)', () => {
  function missing(extra: Record<string, Handler> = {}) {
    return setup({
      'GET /api/status': {
        providerId: 'scrutiny',
        providerStale: false,
        staleAfterHours: 36,
        lastSuccessAt: recent,
        slots: [
          {
            slotId: 's0',
            driveId: 'd0',
            health: 'ok',
            lastReportedAt: recent,
            temperatureC: null,
            detailUrl: null,
            stale: false,
            flag: { kind: 'missing', reason: 'not-reported' },
          },
        ],
      },
      'POST /api/drives/d0/remove': spare,
      'POST /api/drives/d0/retire': installed,
      'POST /api/drives/d0/rma': installed,
      ...extra,
    });
  }
  async function open() {
    renderApp(<App />);
    await userEvent.click((await screen.findAllByRole('button', { name: /^Bay 1.*missing/i }))[0]!);
    return await screen.findByRole('region', { name: 'Drive missing' });
  }

  it('shows the reason and posts remove after a confirm (back to spares)', async () => {
    const calls = missing();
    const box = await open();
    expect(within(box).getByText(/no longer reports/)).toBeInTheDocument();
    await userEvent.click(within(box).getByRole('button', { name: 'Back to spares' }));
    expect(posts(calls, '/api/drives/d0/remove')).toHaveLength(0);
    const dlg = await screen.findByRole('dialog', { name: 'Back to spares' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Move to spares' }));
    await waitFor(() => expect(posts(calls, '/api/drives/d0/remove')).toHaveLength(1));
  });

  it('retire asks for a reason and date, confirms, then posts', async () => {
    const calls = missing();
    const box = await open();
    await userEvent.click(within(box).getByRole('button', { name: 'Retire' }));
    const dlg = await screen.findByRole('dialog', { name: 'Retire AAA0' });
    await pick(within(dlg), /^Reason/, 'Failed');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Review' }));
    await userEvent.click(await within(dlg).findByRole('button', { name: 'Confirm retire' }));
    await waitFor(() => expect(posts(calls, '/api/drives/d0/retire')).toHaveLength(1));
    expect(posts(calls, '/api/drives/d0/retire')[0]!.body).toMatchObject({ reason: 'failed' });
  });

  it('send for RMA confirms with a date, then posts', async () => {
    const calls = missing();
    const box = await open();
    await userEvent.click(within(box).getByRole('button', { name: 'Send for RMA' }));
    const dlg = await screen.findByRole('dialog', { name: 'Send for RMA' });
    // R60: the drive went missing at an unknown time, so the date starts empty and is sent as null.
    expect(within(dlg).getByLabelText(/RMA date/)).toHaveValue('');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Send for RMA' }));
    await waitFor(() => expect(posts(calls, '/api/drives/d0/rma')).toHaveLength(1));
    expect(posts(calls, '/api/drives/d0/rma')[0]!.body).toEqual({ date: null, note: null });
  });

  it('R60: send for RMA with a date typed in sends that date', async () => {
    const calls = missing();
    const box = await open();
    await userEvent.click(within(box).getByRole('button', { name: 'Send for RMA' }));
    const dlg = await screen.findByRole('dialog', { name: 'Send for RMA' });
    fireEvent.change(within(dlg).getByLabelText(/RMA date/), { target: { value: '2026-10-02' } });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Send for RMA' }));
    await waitFor(() => expect(posts(calls, '/api/drives/d0/rma')).toHaveLength(1));
    expect(posts(calls, '/api/drives/d0/rma')[0]!.body).toMatchObject({ date: '2026-10-02' });
  });
});

describe('Pools (R29, R36)', () => {
  it('R36: an installed drive can join a pool (the pool is a property of its installation)', async () => {
    const calls = setup({
      'POST /api/drives/d0/membership': {
        driveId: 'd0',
        slotId: 's0',
        poolId: 'p1',
        poolRole: 'hot-spare',
        installedOn: null,
      },
    });
    renderApp(<App />, '/drives');
    await userEvent.click(await screen.findByText('AAA0'));
    const sec = await screen.findByRole('region', { name: 'Pool membership' });
    expect(await within(sec).findByText('Not in a pool.')).toBeInTheDocument();
    await pick(within(sec), 'Pool', /tank/);
    await pick(within(sec), 'Role', 'Hot spare');
    await userEvent.click(within(sec).getByRole('button', { name: 'Join pool' }));
    await waitFor(() => expect(posts(calls, '/api/drives/d0/membership')).toHaveLength(1));
    expect(posts(calls, '/api/drives/d0/membership')[0]!.body).toEqual({
      poolId: 'p1',
      role: 'hot-spare',
    });
  });
});
