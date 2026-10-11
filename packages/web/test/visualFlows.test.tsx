import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../src/App';
import { makeDrive } from './utils';
import { errorResponse, fixtureData, posts, setupServer } from './server';
import { pickSlot, renderApp } from './utils';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const field = (root: Pick<typeof screen, 'getAllByLabelText'>, label: string | RegExp) =>
  root.getAllByLabelText(label)[0]!;

async function openSlotPanel(name: RegExp) {
  await userEvent.click(await screen.findByRole('button', { name }));
  return screen.findByRole('dialog');
}

describe('Assigning with the slot picker (R70, R8, R35)', () => {
  it('R70: "+ Assign" on an empty slot opens the dialog with that slot already selected', async () => {
    const calls = setupServer();
    renderApp(<App />);
    // An empty tile's "+ Assign" opens the dialog with that slot selected.
    await userEvent.click(await screen.findByRole('button', { name: /^Bay 2, Empty/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Assign to a slot' });
    const bay2 = await within(dlg).findByRole('radio', { name: 'Front bays, Bay 2, empty' });
    expect(bay2).toHaveAttribute('aria-checked', 'true');
    // The spare is chosen on cards, then the slot's pool and role defaults arrive (R35).
    await userEvent.click(within(dlg).getByRole('radio', { name: /SPARE9/ }));
    await waitFor(() => expect(field(within(dlg), 'Pool')).toHaveValue('No pool'));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(posts(calls, '/api/slots/s1/assign')).toHaveLength(1));
    expect(posts(calls, '/api/slots/s1/assign')[0]!.body).toMatchObject({
      driveId: 'd9',
      poolId: null,
      installedOn: expect.stringMatching(DATE),
    });
  });

  it('R8, R70: spare cards show serial, model, capacity, condition and location; retired never appear', async () => {
    setupServer();
    renderApp(<App />);
    // An empty tile's "+ Assign" opens the dialog with that slot selected.
    await userEvent.click(await screen.findByRole('button', { name: /^Bay 2, Empty/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Assign to a slot' });
    const cards = await within(dlg).findAllByRole('radio', { name: /SPARE/ });
    expect(cards).toHaveLength(2);
    const big = within(dlg).getByRole('radio', { name: /SPARE9/ });
    expect(big).toHaveTextContent('Big');
    expect(big).toHaveTextContent('8 TB');
    expect(big).toHaveTextContent('tested');
    expect(big).toHaveTextContent('Desk drawer');
    expect(within(dlg).queryByText('OLD7')).not.toBeInTheDocument();
    expect(within(dlg).queryByRole('textbox', { name: 'Search spares' })).not.toBeInTheDocument();
    // Nothing is chosen yet, so the dialog cannot assign.
    expect(within(dlg).getByRole('button', { name: 'Assign' })).toBeDisabled();
    await userEvent.click(big);
    expect(big).toHaveAttribute('aria-checked', 'true');
    expect(within(dlg).getByRole('button', { name: 'Assign' })).toBeEnabled();
  });

  it('R8: with more than six spares the cards get a search box', async () => {
    const { slots, drives } = fixtureData();
    const many = Array.from({ length: 7 }, (_, i) =>
      makeDrive({
        id: `m${i}`,
        serial: `MANY-${i}`,
        status: 'spare',
        model: i === 3 ? 'Findme' : 'Plain',
      }),
    );
    const all = [...drives, ...many];
    setupServer(
      { 'GET /api/drives?status=spare': all.filter((d) => d.status === 'spare') },
      { slots, drives: all },
    );
    renderApp(<App />);
    // An empty tile's "+ Assign" opens the dialog with that slot selected.
    await userEvent.click(await screen.findByRole('button', { name: /^Bay 2, Empty/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Assign to a slot' });
    await userEvent.type(
      await within(dlg).findByRole('textbox', { name: 'Search spares' }),
      'findme',
    );
    expect(within(dlg).getAllByRole('radio', { name: /MANY-/ })).toHaveLength(1);
    expect(within(dlg).getByRole('radio', { name: /MANY-3/ })).toBeInTheDocument();
  });

  it('R70, R37: picking an occupied tile leads into the occupant step and posts that slot', async () => {
    const calls = setupServer();
    renderApp(<App />, '/');
    await userEvent.click(await screen.findByRole('button', { name: 'Assign SPARE9' }));
    const dlg = await screen.findByRole('dialog', { name: 'Assign to a slot' });
    await pickSlot(within(dlg), /Bay 3, occupied by CCC2/);
    await waitFor(() => expect(field(within(dlg), 'Pool')).toHaveValue('tank · raidz2'));
    expect(within(dlg).getByText(/This slot is occupied by CCC2/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Next' }));
    const occ = await screen.findByRole('dialog', { name: 'Bay 3 is occupied' });
    await userEvent.click(within(occ).getByRole('button', { name: 'Move to spares and assign' }));
    await waitFor(() => expect(posts(calls, '/api/slots/s2/assign')).toHaveLength(1));
    expect(posts(calls, '/api/slots/s2/assign')[0]!.body).toMatchObject({
      driveId: 'd9',
      poolId: 'p1',
      role: 'hot-spare',
      occupant: { action: 'spare', removedOn: expect.stringMatching(DATE) },
    });
  });

  it('R69: in the occupant step "Removed on" can be changed or cleared (sent as null)', async () => {
    const calls = setupServer();
    renderApp(<App />, '/');
    await userEvent.click(await screen.findByRole('button', { name: 'Assign SPARE9' }));
    const dlg = await screen.findByRole('dialog', { name: 'Assign to a slot' });
    await pickSlot(within(dlg), /Bay 1, occupied/);
    await waitFor(() => expect(field(within(dlg), 'Pool')).toHaveValue('tank · raidz2'));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Next' }));
    const occ = await screen.findByRole('dialog', { name: 'Bay 1 is occupied' });
    const removed = within(occ).getByLabelText('Removed on (optional)');
    expect((removed as HTMLInputElement).value).toMatch(DATE);
    await userEvent.click(within(occ).getByRole('button', { name: 'Clear' }));
    await userEvent.click(within(occ).getByRole('button', { name: 'Move to spares and assign' }));
    await waitFor(() => expect(posts(calls, '/api/slots/s0/assign')).toHaveLength(1));
    expect(posts(calls, '/api/slots/s0/assign')[0]!.body).toMatchObject({
      occupant: { action: 'spare', removedOn: null },
    });
  });
});

describe('Remove to spares with an optional removal date (R69)', () => {
  it('R69: defaults to today and sends the date that was set', async () => {
    const calls = setupServer();
    renderApp(<App />);
    const panel = await openSlotPanel(/^Bay 1, /);
    await userEvent.click(await within(panel).findByRole('button', { name: 'Remove to spares' }));
    const dlg = await screen.findByRole('dialog', { name: 'Remove to spares' });
    const date = within(dlg).getByLabelText('Removed on (optional)');
    expect(date).toHaveAttribute('type', 'date');
    expect((date as HTMLInputElement).value).toMatch(DATE);
    expect(
      within(dlg).getByText(
        'Leave empty if you don’t know — it’s better to show ‘not recorded’ than a guess.',
      ),
    ).toBeInTheDocument();
    fireEvent.change(date, { target: { value: '2026-09-30' } });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Remove to spares' }));
    await waitFor(() => expect(posts(calls, '/api/drives/d0/remove')).toHaveLength(1));
    expect(posts(calls, '/api/drives/d0/remove')[0]!.body).toEqual({ removedOn: '2026-09-30' });
  });

  it('R69: Clear sends an explicit null (not recorded); Today refills the field', async () => {
    const calls = setupServer();
    renderApp(<App />);
    const panel = await openSlotPanel(/^Bay 1, /);
    await userEvent.click(await within(panel).findByRole('button', { name: 'Remove to spares' }));
    const dlg = await screen.findByRole('dialog', { name: 'Remove to spares' });
    const date = within(dlg).getByLabelText('Removed on (optional)');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Clear' }));
    expect(date).toHaveValue('');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Today' }));
    expect((date as HTMLInputElement).value).toMatch(DATE);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Clear' }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Remove to spares' }));
    await waitFor(() => expect(posts(calls, '/api/drives/d0/remove')).toHaveLength(1));
    expect(posts(calls, '/api/drives/d0/remove')[0]!.body).toEqual({ removedOn: null });
  });

  it('R69: a future date is refused before sending; server date errors show inline', async () => {
    const calls = setupServer({
      'POST /api/drives/d0/remove': () =>
        errorResponse(400, 'validation', 'The removal date is before the installation date.'),
    });
    renderApp(<App />);
    const panel = await openSlotPanel(/^Bay 1, /);
    await userEvent.click(await within(panel).findByRole('button', { name: 'Remove to spares' }));
    const dlg = await screen.findByRole('dialog', { name: 'Remove to spares' });
    const date = within(dlg).getByLabelText('Removed on (optional)');
    fireEvent.change(date, { target: { value: '2999-01-01' } });
    expect(await within(dlg).findByText(/cannot be in the future/)).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: 'Remove to spares' })).toBeDisabled();
    fireEvent.change(date, { target: { value: '2001-01-01' } });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Remove to spares' }));
    expect(await within(dlg).findByText(/before the installation date/)).toBeInTheDocument();
    expect(posts(calls, '/api/drives/d0/remove')).toHaveLength(1);
  });

  it('R69, R27: the missing-drive panel starts the removal date empty and sends null unless filled in', async () => {
    const calls = setupServer({}, { flagSlot: 's0' });
    renderApp(<App />);
    const panel = await openSlotPanel(/^Bay 1, /);
    await userEvent.click(await within(panel).findByRole('button', { name: 'Back to spares' }));
    const dlg = await screen.findByRole('dialog', { name: 'Back to spares' });
    const date = within(dlg).getByLabelText('Removed on (optional)');
    expect(date).toHaveValue('');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Move to spares' }));
    await waitFor(() => expect(posts(calls, '/api/drives/d0/remove')).toHaveLength(1));
    expect(posts(calls, '/api/drives/d0/remove')[0]!.body).toEqual({ removedOn: null });
  });

  it('R69, R27: a date typed in the missing-drive panel is sent', async () => {
    const calls = setupServer({}, { flagSlot: 's0' });
    renderApp(<App />);
    const panel = await openSlotPanel(/^Bay 1, /);
    await userEvent.click(await within(panel).findByRole('button', { name: 'Back to spares' }));
    const dlg = await screen.findByRole('dialog', { name: 'Back to spares' });
    fireEvent.change(within(dlg).getByLabelText('Removed on (optional)'), {
      target: { value: '2026-08-15' },
    });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Move to spares' }));
    await waitFor(() => expect(posts(calls, '/api/drives/d0/remove')).toHaveLength(1));
    expect(posts(calls, '/api/drives/d0/remove')[0]!.body).toEqual({ removedOn: '2026-08-15' });
  });
});

describe('Replace (R70, R60, R62, R35)', () => {
  async function openReplace() {
    renderApp(<App />);
    const panel = await openSlotPanel(/^Bay 3, /);
    await userEvent.click(await within(panel).findByRole('button', { name: 'Replace' }));
    return screen.findByRole('dialog', { name: 'Replace CCC2' });
  }
  const next = (dlg: HTMLElement) =>
    userEvent.click(within(dlg).getByRole('button', { name: 'Next' }));

  it('R70: only installed drives in a slot offer it', async () => {
    setupServer();
    renderApp(<App />, '/drives');
    await userEvent.click(await screen.findByText('SPARE9'));
    await screen.findByRole('button', { name: 'Assign to slot' });
    expect(screen.queryByRole('button', { name: 'Replace' })).not.toBeInTheDocument();
  });

  it('R70, R60: step 1 shows the bay highlighted and both capacities side by side', async () => {
    setupServer();
    const dlg = await openReplace();
    const current = await within(dlg).findByLabelText('Front bays, Bay 3, occupied by CCC2');
    expect(current).toHaveAttribute('aria-current', 'true');
    expect(within(dlg).queryByRole('radio', { name: /Bay/ })).not.toBeInTheDocument();
    const compare = within(dlg).getByRole('group', { name: 'Swap capacity comparison' });
    expect(within(compare).getByText('Choose below')).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: 'Next' })).toBeDisabled();
    await userEvent.click(within(dlg).getByRole('radio', { name: /SPARE9/ }));
    expect(within(compare).getByText('8 TB')).toBeInTheDocument();
    expect(within(compare).getByText('4 TB')).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('R70: spares of the same type and at least the size are suggested first; smaller ones carry a note', async () => {
    const { slots, drives } = fixtureData();
    const extra = [
      makeDrive({ id: 'n1', serial: 'SMALL1', status: 'spare', capacityBytes: 2e12 }),
      makeDrive({
        id: 'n2',
        serial: 'SSD1',
        status: 'spare',
        capacityBytes: 8e12,
        driveType: 'SSD',
      }),
    ];
    const all = [
      ...drives.filter((d) => d.id !== 'd8'),
      ...extra,
      drives.find((d) => d.id === 'd8')!,
    ];
    setupServer(
      { 'GET /api/drives?status=spare': all.filter((d) => d.status === 'spare') },
      { slots, drives: all },
    );
    const dlg = await openReplace();
    const cards = await within(dlg).findAllByRole('radio', { name: /SPARE|SMALL|SSD/ });
    // Same type (HDD) and >= 4 TB first, closest size first; then the rest.
    expect(cards.map((c) => c.textContent?.match(/SPARE\d|SMALL1|SSD1/)?.[0])).toEqual([
      'SPARE8',
      'SPARE9',
      'SMALL1',
      'SSD1',
    ]);
    expect(within(cards[0]!).getByText(/Suggested/)).toHaveTextContent('Same type, ≥ 4 TB');
    expect(
      within(cards[2]!).getByText(/Smaller than the current drive \(2 TB vs 4 TB\)/),
    ).toBeInTheDocument();
    expect(within(cards[3]!).queryByText(/Suggested/)).not.toBeInTheDocument();
    // The note does not block choosing it.
    await userEvent.click(cards[2]!);
    expect(within(dlg).getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('R70, R69: swap date defaults to today; back to spares posts ONE assign using it for both drives', async () => {
    const calls = setupServer();
    const dlg = await openReplace();
    await userEvent.click(within(dlg).getByRole('radio', { name: /SPARE9/ }));
    await next(dlg);
    const date = within(dlg).getByLabelText('When was it swapped? (optional)');
    expect((date as HTMLInputElement).value).toMatch(DATE);
    expect(within(dlg).getByText(/better to show ‘not recorded’ than a guess/)).toBeInTheDocument();
    fireEvent.change(date, { target: { value: '2026-10-01' } });
    await next(dlg);
    expect(within(dlg).getByText('Still works — e.g. too small')).toBeInTheDocument();
    // R35: pool and role come from the outgoing drive's slot, editable in the collapsed section.
    await waitFor(() =>
      expect(within(dlg).getByText(/Pool & role: tank · hot spare/)).toBeInTheDocument(),
    );
    await userEvent.click(within(dlg).getByRole('button', { name: 'Review' }));
    expect(
      await within(dlg).findByText(/swapped on 2026-10-01, old drive: back to spares/),
    ).toBeInTheDocument();
    expect(posts(calls, '/api/slots/s2/assign')).toHaveLength(0);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Confirm replacement' }));
    await waitFor(() => expect(posts(calls, '/api/slots/s2/assign')).toHaveLength(1));
    expect(posts(calls, '/api/slots/s2/assign')[0]!.body).toEqual({
      driveId: 'd9',
      poolId: 'p1',
      role: 'hot-spare',
      installedOn: '2026-10-01',
      occupant: { action: 'spare', removedOn: '2026-10-01' },
    });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('R62, R60: retire needs a reason (no default), replaced-by is always the incoming drive', async () => {
    const calls = setupServer();
    const dlg = await openReplace();
    await userEvent.click(within(dlg).getByRole('radio', { name: /SPARE9/ }));
    await next(dlg);
    fireEvent.change(within(dlg).getByLabelText('When was it swapped? (optional)'), {
      target: { value: '2026-09-12' },
    });
    await next(dlg);
    await userEvent.click(within(dlg).getByRole('radio', { name: 'Retire' }));
    expect(within(dlg).getByText('Broken or done')).toBeInTheDocument();
    expect(field(within(dlg), /^Reason/)).toHaveValue('');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Review' }));
    expect(await within(dlg).findByText('Choose a reason.')).toBeInTheDocument();
    await userEvent.click(field(within(dlg), /^Reason/));
    await userEvent.click(await screen.findByRole('option', { name: 'Failed', hidden: true }));
    await userEvent.type(within(dlg).getByLabelText(/^Note/), 'Clicking');
    // The swap date is set, so no separate retirement date is asked for.
    expect(within(dlg).queryByLabelText(/Retirement date/)).not.toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Review' }));
    expect(await within(dlg).findByText(/old drive: retired \(failed\)/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Confirm replacement' }));
    await waitFor(() => expect(posts(calls, '/api/slots/s2/assign')).toHaveLength(1));
    expect(posts(calls, '/api/slots/s2/assign')[0]!.body).toMatchObject({
      driveId: 'd9',
      installedOn: '2026-09-12',
      occupant: {
        action: 'retire',
        reason: 'failed',
        date: '2026-09-12',
        note: 'Clicking',
        replacedByDriveId: 'd9',
      },
    });
  });

  it('R60, R27, R68: with no swap date, installedOn is null and retire or RMA ask for their own date', async () => {
    const calls = setupServer();
    const dlg = await openReplace();
    await userEvent.click(within(dlg).getByRole('radio', { name: /SPARE8/ }));
    await next(dlg);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Clear' }));
    await next(dlg);
    await userEvent.click(within(dlg).getByRole('radio', { name: 'Send for RMA' }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Review' }));
    expect(
      await within(dlg).findByText(/Enter the date for the retirement or RMA/),
    ).toBeInTheDocument();
    fireEvent.change(within(dlg).getByLabelText(/Retirement date/), {
      target: { value: '2026-10-02' },
    });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Review' }));
    expect(
      await within(dlg).findByText(
        /swapped on not recorded, old drive: sent for RMA on 2026-10-02/,
      ),
    ).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Confirm replacement' }));
    await waitFor(() => expect(posts(calls, '/api/slots/s2/assign')).toHaveLength(1));
    expect(posts(calls, '/api/slots/s2/assign')[0]!.body).toMatchObject({
      driveId: 'd8',
      installedOn: null,
      occupant: { action: 'rma', date: '2026-10-02', note: null },
    });
  });

  it('R69: with no swap date, back to spares sends removedOn null', async () => {
    const calls = setupServer();
    const dlg = await openReplace();
    await userEvent.click(within(dlg).getByRole('radio', { name: /SPARE9/ }));
    await next(dlg);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Clear' }));
    await next(dlg);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Review' }));
    await userEvent.click(await within(dlg).findByRole('button', { name: 'Confirm replacement' }));
    await waitFor(() => expect(posts(calls, '/api/slots/s2/assign')).toHaveLength(1));
    expect(posts(calls, '/api/slots/s2/assign')[0]!.body).toMatchObject({
      installedOn: null,
      occupant: { action: 'spare', removedOn: null },
    });
  });

  it('R69: a server date error appears inline in the confirm step and nothing closes', async () => {
    setupServer({
      'POST /api/slots/s2/assign': () =>
        errorResponse(400, 'validation', 'The removal date is before the installation date.'),
    });
    const dlg = await openReplace();
    await userEvent.click(within(dlg).getByRole('radio', { name: /SPARE9/ }));
    await next(dlg);
    await next(dlg);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Review' }));
    await userEvent.click(await within(dlg).findByRole('button', { name: 'Confirm replacement' }));
    expect(await within(dlg).findByText(/before the installation date/)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Replace CCC2' })).toBeInTheDocument();
  });
});

describe('Spare and retired history (owner request)', () => {
  it('a spares-shelf row opens the drive drawer with its History; Assign stays separate', async () => {
    setupServer({
      'GET /api/drives/d9/events': [
        {
          id: 'h1',
          driveId: 'd9',
          type: 'drive-created',
          at: '2026-03-01T09:00:00.000Z',
          payload: {},
        },
      ],
    });
    renderApp(<App />);
    const shelf = await screen.findByLabelText('Spares shelf');
    await userEvent.click(within(shelf).getByText('Big'));
    const drawer = await screen.findByRole('dialog', { name: 'Spare drive' });
    expect(within(drawer).getByRole('heading', { name: 'SPARE9' })).toBeInTheDocument();
    expect(await within(drawer).findByRole('heading', { name: 'History' })).toBeInTheDocument();
    expect(await within(drawer).findByText('Added to Sparrow')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Spare drive' })).not.toBeInTheDocument(),
    );
    await userEvent.click(within(shelf).getByRole('button', { name: 'Assign SPARE9' }));
    expect(await screen.findByRole('dialog', { name: 'Assign to a slot' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Spare drive' })).not.toBeInTheDocument();
  });

  it('the shelf links to retired drives and the Drives page filters from the URL', async () => {
    setupServer();
    renderApp(<App />);
    const shelf = await screen.findByLabelText('Spares shelf');
    const link = await within(shelf).findByRole('link', { name: 'Retired drives (1) →' });
    expect(link).toHaveAttribute('href', '/drives?status=retired');
    await userEvent.click(link);
    expect(await screen.findByText('OLD7')).toBeInTheDocument();
    expect(screen.queryByText('SPARE9')).not.toBeInTheDocument();
    expect(screen.queryByText('AAA0')).not.toBeInTheDocument();
  });

  it('changing the Drives filter writes it to the URL', async () => {
    setupServer();
    renderApp(<App />, '/drives?status=spare');
    expect(await screen.findByText('SPARE9')).toBeInTheDocument();
    expect(screen.queryByText('OLD7')).not.toBeInTheDocument();
    await userEvent.click(screen.getByText(/^Retired/, { selector: 'label *, label' }));
    expect(await screen.findByText('OLD7')).toBeInTheDocument();
    expect(screen.queryByText('SPARE9')).not.toBeInTheDocument();
  });
});

describe('Life story shows removal dates (R69)', () => {
  it('R69: a backdated removal and an unrecorded one render with their markers', async () => {
    const event = (id: string, type: string, at: string, payload: Record<string, unknown>) => ({
      id,
      driveId: 'd0',
      type,
      at,
      payload,
    });
    const at = '2026-10-11T09:00:00.000Z';
    setupServer({
      'GET /api/drives/d0/events': [
        event('e5', 'drive-removed', at, {
          slotLabel: 'Bay 1',
          gridName: 'Front bays',
          removedOn: null,
        }),
        event('e4', 'drive-installed', '2026-06-01T09:00:00.000Z', {
          slotLabel: 'Bay 1',
          gridName: 'Front bays',
          installedOn: '2026-06-01',
        }),
        event('e3', 'drive-removed', '2026-05-20T09:00:00.000Z', {
          slotLabel: 'Bay 1',
          gridName: 'Front bays',
          removedOn: '2026-05-01',
        }),
        event('e2', 'drive-installed', '2025-01-01T09:00:00.000Z', {
          slotLabel: 'Bay 1',
          gridName: 'Front bays',
          installedOn: '2025-01-01',
        }),
        event('e1', 'drive-created', '2024-12-01T09:00:00.000Z', {}),
      ],
    });
    renderApp(<App />);
    const panel = await openSlotPanel(/^Bay 1, /);
    const story = await within(panel).findByRole('region', { name: 'Life story' });
    expect(
      await within(story).findByText('Removed from Front bays, Bay 1 (removal date not recorded)'),
    ).toBeInTheDocument();
    expect(within(story).getByText('2026-05-01')).toBeInTheDocument();
    expect(within(story).getByText(/recorded 2026-05-20/)).toBeInTheDocument();
    expect(within(story).getByText(/removal date unknown/)).toBeInTheDocument();
    const items = within(story).getAllByRole('listitem');
    expect(items.filter((i) => i.getAttribute('data-unrecorded') === 'true')).toHaveLength(1);
    // The summary line under the heading says it too (capital R, unlike the item title).
    expect(within(story).getByText(/Removal date not recorded/)).toBeInTheDocument();
  });
});
