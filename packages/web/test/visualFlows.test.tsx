import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from './user';
import { App } from '../src/App';
import { makeDrive } from './utils';
import { errorResponse, fixtureData, posts, setupServer } from './server';
import { act, ev } from './activities';
import { next, pickSlot, renderApp } from './utils';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const field = (root: Pick<typeof screen, 'getAllByLabelText'>, label: string | RegExp) =>
  root.getAllByLabelText(label)[0]!;

async function openSlotPanel(name: RegExp) {
  await userEvent.click(await screen.findByRole('button', { name }));
  return screen.findByRole('dialog');
}

/** An empty tile opens the slot panel (its slot history); "Assign a drive" starts the dialog. */
async function openAssignFromEmpty(name: RegExp = /^Bay 2, Empty/) {
  const panel = await openSlotPanel(name);
  await userEvent.click(await within(panel).findByRole('button', { name: 'Assign a drive' }));
  return screen.findByRole('dialog', { name: 'Assign to a slot' });
}

describe('Assigning with the slot picker (R70, R8, R35)', () => {
  it('R70: "Assign a drive" in an the empty slot panel opens the dialog with that slot already selected', async () => {
    const calls = setupServer();
    renderApp(<App />);
    const dlg = await openAssignFromEmpty();
    // The slot step is skipped: the first step is the drive, with the bay as a read-only summary.
    expect(within(dlg).getByText(/Step 1 of 3 · Choose the drive/)).toBeInTheDocument();
    expect(within(dlg).getByText('Bay 2')).toBeInTheDocument();
    expect(within(dlg).queryByRole('radio', { name: /Front bays, Bay/ })).not.toBeInTheDocument();
    // The spare is chosen on cards, then the slot's pool and role defaults arrive (R35).
    await userEvent.click(await within(dlg).findByRole('radio', { name: /SPARE9/ }));
    await next(within(dlg));
    await waitFor(() => expect(field(within(dlg), 'Pool')).toHaveValue('No pool'));
    await next(within(dlg));
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
    const dlg = await openAssignFromEmpty();
    const cards = await within(dlg).findAllByRole('radio', { name: /SPARE/ });
    expect(cards).toHaveLength(2);
    const big = within(dlg).getByRole('radio', { name: /SPARE9/ });
    expect(big).toHaveTextContent('Big');
    expect(big).toHaveTextContent('8 TB');
    expect(big).toHaveTextContent('tested');
    expect(big).toHaveTextContent('Desk drawer');
    expect(within(dlg).queryByText('OLD7')).not.toBeInTheDocument();
    expect(within(dlg).queryByRole('textbox', { name: 'Search spares' })).not.toBeInTheDocument();
    // The picker step shows nothing else, and nothing is chosen yet, so Next is disabled.
    expect(within(dlg).queryByLabelText('Pool')).not.toBeInTheDocument();
    expect(within(dlg).queryByLabelText('Installed on (optional)')).not.toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: 'Next' })).toBeDisabled();
    await userEvent.click(big);
    expect(big).toHaveAttribute('aria-checked', 'true');
    expect(within(dlg).getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('R70: opened from a slot, "Change" brings the slot step back and the step count follows', async () => {
    const calls = setupServer();
    renderApp(<App />);
    const dlg = await openAssignFromEmpty();
    expect(within(dlg).getByText(/Step 1 of 3 · Choose the drive/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Change' }));
    // The picker is alone on its step, with Bay 2 still selected.
    expect(within(dlg).getByText(/Step 1 of 4 · Choose the slot/)).toBeInTheDocument();
    expect(within(dlg).getByRole('radio', { name: 'Front bays, Bay 2, empty' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(dlg).queryByRole('radio', { name: /SPARE9/ })).not.toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: 'Change' })).not.toBeInTheDocument();
    await pickSlot(within(dlg), /Bay 1, occupied/);
    await next(within(dlg));
    expect(within(dlg).getByText(/Step 2 of 5 · Choose the drive/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('radio', { name: /SPARE9/ }));
    await next(within(dlg));
    expect(
      within(dlg).getByText(/Step 3 of 5 · What happens to the drive in this bay/),
    ).toBeInTheDocument();
    // Back keeps the choices made on earlier steps.
    await userEvent.click(within(dlg).getByRole('button', { name: 'Back' }));
    expect(within(dlg).getByRole('radio', { name: /SPARE9/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await userEvent.click(within(dlg).getByRole('button', { name: 'Back' }));
    expect(within(dlg).getByRole('radio', { name: /Bay 1, occupied/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(dlg).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(posts(calls, '/api/slots/s0/assign')).toHaveLength(0);
  });

  it('R70: the confirm step summarises the placement before the one API call', async () => {
    const calls = setupServer();
    renderApp(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Assign SPARE9' }));
    const dlg = await screen.findByRole('dialog', { name: 'Assign to a slot' });
    await pickSlot(within(dlg), /Bay 2, empty/);
    await next(within(dlg));
    await next(within(dlg));
    expect(within(dlg).getByText(/Step 3 of 3 · Confirm/)).toBeInTheDocument();
    expect(within(dlg).getByText(/goes into/)).toHaveTextContent(/SPARE9.*goes into Bay 2/);
    expect(posts(calls, '/api/slots/s1/assign')).toHaveLength(0);
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
    const dlg = await openAssignFromEmpty();
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
    expect(within(dlg).getByText(/Step 1 of 3 · Choose the slot/)).toBeInTheDocument();
    await pickSlot(within(dlg), /Bay 3, occupied by CCC2/);
    // The occupant step is added once the chosen slot is occupied.
    expect(within(dlg).getByText(/Step 1 of 4 · Choose the slot/)).toBeInTheDocument();
    await next(within(dlg));
    const occ = dlg;
    expect(
      within(occ).getByText(/Step 2 of 4 · What happens to the drive in this bay/),
    ).toBeInTheDocument();
    await next(within(occ));
    await waitFor(() => expect(field(within(dlg), 'Pool')).toHaveValue('tank · raidz2'));
    await next(within(occ));
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
    await next(within(dlg));
    const occ = dlg;
    const removed = within(occ).getByLabelText('Removed on (optional)');
    expect((removed as HTMLInputElement).value).toMatch(DATE);
    await userEvent.click(within(occ).getByRole('button', { name: 'Clear' }));
    await next(within(occ));
    await next(within(occ));
    await userEvent.click(within(occ).getByRole('button', { name: 'Move to spares and assign' }));
    await waitFor(() => expect(posts(calls, '/api/slots/s0/assign')).toHaveLength(1));
    expect(posts(calls, '/api/slots/s0/assign')[0]!.body).toMatchObject({
      occupant: { action: 'spare', removedOn: null },
    });
  });
});

describe('Missing drive back to spares with an optional removal date (R69, R27)', () => {
  it('R69, R27: the panel starts the removal date empty and sends null unless filled in', async () => {
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

describe('Move (R73, R60, R62, R35, R68, R69)', () => {
  async function openMove(bay = /^Bay 3, /, serial = 'CCC2') {
    renderApp(<App />);
    const panel = await openSlotPanel(bay);
    await userEvent.click(await within(panel).findByRole('button', { name: 'Move' }));
    return screen.findByRole('dialog', { name: `Move ${serial}` });
  }
  const nextStep = (dlg: HTMLElement) => next(within(dlg));
  const card = (dlg: HTMLElement, name: string | RegExp) =>
    within(dlg).findByRole('radio', { name });
  const confirmMove = (dlg: HTMLElement) =>
    userEvent.click(within(dlg).getByRole('button', { name: 'Confirm move' }));
  const moves = (calls: ReturnType<typeof setupServer>, id = 'd2') =>
    posts(calls, `/api/drives/${id}/move`);
  /** Through to the confirm step with the answers "leave it empty". */
  async function toConfirm(dlg: HTMLElement, destination: string | RegExp) {
    await userEvent.click(await card(dlg, destination));
    await nextStep(dlg);
    await userEvent.click(await card(dlg, 'Leave it empty'));
    await nextStep(dlg);
  }

  it('R73: an installed drive offers Move and Retire; the old Replace and Remove to spares are gone', async () => {
    setupServer();
    renderApp(<App />);
    const panel = await openSlotPanel(/^Bay 3, /);
    await within(panel).findByRole('button', { name: 'Move' });
    expect(within(panel).getByRole('button', { name: 'Retire' })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Replace' })).not.toBeInTheDocument();
    expect(
      within(panel).queryByRole('button', { name: 'Remove to spares' }),
    ).not.toBeInTheDocument();
  });

  it('R73: spares and retired drives offer no Move', async () => {
    setupServer();
    renderApp(<App />, '/drives');
    await userEvent.click(await screen.findByText('SPARE9'));
    await screen.findByRole('button', { name: 'Assign to slot' });
    expect(screen.queryByRole('button', { name: 'Move' })).not.toBeInTheDocument();
  });

  it('R73: step 1 asks where it goes with four answers; nothing is chosen yet', async () => {
    setupServer();
    const dlg = await openMove();
    expect(within(dlg).getByText(/Step 1 of 3 · Where does this drive go\?/)).toBeInTheDocument();
    const radios = within(dlg).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Spares shelf'),
      expect.stringContaining('Another bay'),
      expect.stringContaining('Retire'),
      expect.stringContaining('Send for RMA'),
    ]);
    expect(radios.every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
    expect(within(dlg).getByRole('button', { name: 'Next' })).toBeDisabled();
    // The one date lives on this step, below the answers.
    expect(within(dlg).getByLabelText('When? (optional)')).toHaveAttribute('type', 'date');
  });

  it('R73, R69: to the spares shelf, leaving the bay empty: ONE move call, date today by default', async () => {
    const calls = setupServer();
    const dlg = await openMove();
    await userEvent.click(await card(dlg, /Spares shelf/));
    const date = within(dlg).getByLabelText('When? (optional)');
    expect(date).toHaveAttribute('type', 'date');
    expect((date as HTMLInputElement).value).toMatch(DATE);
    expect(within(dlg).getByText(/better to show ‘not recorded’ than a guess/)).toBeInTheDocument();
    await nextStep(dlg);
    await userEvent.click(await card(dlg, 'Leave it empty'));
    await nextStep(dlg);
    expect(within(dlg).getByText(/Step 3 of 3 · Confirm/)).toBeInTheDocument();
    expect(within(dlg).getByText(/goes back to the spares shelf/)).toBeInTheDocument();
    expect(within(dlg).getByText(/is left empty/)).toBeInTheDocument();
    expect(moves(calls)).toHaveLength(0);
    await confirmMove(dlg);
    await waitFor(() => expect(moves(calls)).toHaveLength(1));
    expect(moves(calls)[0]!.body).toEqual({
      destination: { kind: 'spares' },
      date: expect.stringMatching(DATE),
    });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('R73, R69, R68: a typed date is sent; Clear sends null; Today refills the field', async () => {
    const calls = setupServer();
    const dlg = await openMove();
    await userEvent.click(await card(dlg, /Spares shelf/));
    const date = within(dlg).getByLabelText('When? (optional)');
    fireEvent.change(date, { target: { value: '2026-09-30' } });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Clear' }));
    expect(date).toHaveValue('');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Today' }));
    expect((date as HTMLInputElement).value).toMatch(DATE);
    fireEvent.change(date, { target: { value: '2026-09-30' } });
    await nextStep(dlg);
    await userEvent.click(await card(dlg, 'Leave it empty'));
    await nextStep(dlg);
    expect(dlg.querySelector('.step-content')).toHaveTextContent(/Date: 2026-09-30\./);
    await confirmMove(dlg);
    await waitFor(() => expect(moves(calls)).toHaveLength(1));
    expect(moves(calls)[0]!.body).toEqual({ destination: { kind: 'spares' }, date: '2026-09-30' });
  });

  it('R73, R69: an empty date is sent as null (not recorded for every part of the move)', async () => {
    const calls = setupServer();
    const dlg = await openMove();
    await userEvent.click(await card(dlg, /Spares shelf/));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Clear' }));
    await nextStep(dlg);
    await userEvent.click(await card(dlg, 'Leave it empty'));
    await nextStep(dlg);
    expect(within(dlg).getByText(/No date is recorded\./)).toBeInTheDocument();
    await confirmMove(dlg);
    await waitFor(() => expect(moves(calls)).toHaveLength(1));
    expect(moves(calls)[0]!.body).toEqual({ destination: { kind: 'spares' }, date: null });
  });

  it('R73, R68: a future date is refused before sending', async () => {
    const calls = setupServer();
    const dlg = await openMove();
    await userEvent.click(await card(dlg, /Spares shelf/));
    fireEvent.change(within(dlg).getByLabelText('When? (optional)'), {
      target: { value: '2999-01-01' },
    });
    expect(await within(dlg).findByText('The date cannot be in the future.')).toBeInTheDocument();
    // Next stays disabled on step 1 until the date is fixed.
    expect(within(dlg).getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(within(dlg).getByText(/Step 1 of 3 · Where does this drive go\?/)).toBeInTheDocument();
    expect(moves(calls)).toHaveLength(0);
  });

  it('R73, R60: step 2 compares both capacities; same-type spares of at least the size come first, smaller ones carry a note', async () => {
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
    const dlg = await openMove();
    await userEvent.click(await card(dlg, /Spares shelf/));
    await nextStep(dlg);
    expect(within(dlg).getByText(/Step 2 of 3 · What goes into this bay\?/)).toBeInTheDocument();
    expect(within(dlg).queryByRole('radio', { name: /SPARE/ })).not.toBeInTheDocument();
    await userEvent.click(await card(dlg, /A spare/));
    const cards = await within(dlg).findAllByRole('radio', { name: /SPARE|SMALL|SSD/ });
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
    expect(within(dlg).getByRole('button', { name: 'Next' })).toBeDisabled();
    await userEvent.click(cards[1]!);
    expect(within(dlg).getByText(/Out:/)).toHaveTextContent('CCC2 (4 TB) · In: SPARE9 (8 TB)');
    expect(within(dlg).getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('R73, R35, R60: spares shelf with a spare into the bay: pool and role default from the old drive, one call', async () => {
    const calls = setupServer();
    const dlg = await openMove();
    await userEvent.click(await card(dlg, /Spares shelf/));
    fireEvent.change(within(dlg).getByLabelText('When? (optional)'), {
      target: { value: '2026-10-01' },
    });
    await nextStep(dlg);
    await userEvent.click(await card(dlg, /A spare/));
    await userEvent.click(await within(dlg).findByRole('radio', { name: /SPARE9/ }));
    await nextStep(dlg);
    expect(within(dlg).getByText(/Step 3 of 4 · Details/)).toBeInTheDocument();
    await waitFor(() => expect(field(within(dlg), 'Pool')).toHaveValue('tank · raidz2'));
    expect(field(within(dlg), 'Role')).toHaveValue('Hot spare');
    await nextStep(dlg);
    expect(dlg.querySelector('.step-content')).toHaveTextContent(
      /SPARE9 \(8 TB\) goes into Front bays, Bay 3, joining tank as hot spare/,
    );
    expect(moves(calls)).toHaveLength(0);
    await confirmMove(dlg);
    await waitFor(() => expect(moves(calls)).toHaveLength(1));
    expect(moves(calls)[0]!.body).toEqual({
      destination: { kind: 'spares' },
      replacement: { driveId: 'd9', poolId: 'p1', role: 'hot-spare' },
      date: '2026-10-01',
    });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('R73, R62, R60: retire needs a reason (no default); a spare can take the bay', async () => {
    const calls = setupServer();
    const dlg = await openMove();
    await userEvent.click(await card(dlg, /^Retire/));
    expect(within(dlg).getByText('Broken or done')).toBeInTheDocument();
    expect(field(within(dlg), /^Reason/)).toHaveValue('');
    expect(within(dlg).getByRole('button', { name: 'Next' })).toBeDisabled();
    await userEvent.click(field(within(dlg), /^Reason/));
    await userEvent.click(await screen.findByRole('option', { name: 'Failed', hidden: true }));
    await userEvent.type(within(dlg).getByLabelText(/^Note/), 'Clicking');
    fireEvent.change(within(dlg).getByLabelText('When? (optional)'), {
      target: { value: '2026-09-12' },
    });
    await nextStep(dlg);
    await userEvent.click(await card(dlg, /A spare/));
    await userEvent.click(await within(dlg).findByRole('radio', { name: /SPARE9/ }));
    await nextStep(dlg);
    await nextStep(dlg);
    expect(within(dlg).getByText(/is retired \(failed\)/)).toBeInTheDocument();
    await confirmMove(dlg);
    await waitFor(() => expect(moves(calls)).toHaveLength(1));
    expect(moves(calls)[0]!.body).toEqual({
      destination: { kind: 'retire', reason: 'failed', note: 'Clicking' },
      replacement: { driveId: 'd9', poolId: 'p1', role: 'hot-spare' },
      date: '2026-09-12',
    });
  });

  it('R73, R60: the Retire button opens Move with Retire already chosen', async () => {
    const calls = setupServer();
    renderApp(<App />);
    const panel = await openSlotPanel(/^Bay 3, /);
    await userEvent.click(await within(panel).findByRole('button', { name: 'Retire' }));
    const dlg = await screen.findByRole('dialog', { name: 'Move CCC2' });
    expect(await card(dlg, /^Retire/)).toHaveAttribute('aria-checked', 'true');
    expect(field(within(dlg), /^Reason/)).toHaveValue('');
    expect(within(dlg).getByRole('button', { name: 'Next' })).toBeDisabled();
    await userEvent.click(field(within(dlg), /^Reason/));
    await userEvent.click(await screen.findByRole('option', { name: 'Other', hidden: true }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Clear' }));
    await nextStep(dlg);
    await userEvent.click(await card(dlg, 'Leave it empty'));
    await nextStep(dlg);
    expect(within(dlg).getByText(/No date is recorded/)).toBeInTheDocument();
    await confirmMove(dlg);
    await waitFor(() => expect(moves(calls)).toHaveLength(1));
    expect(moves(calls)[0]!.body).toEqual({
      destination: { kind: 'retire', reason: 'other', note: null },
      date: null,
    });
  });

  it('R73, R27: Send for RMA with a note', async () => {
    const calls = setupServer();
    const dlg = await openMove();
    await userEvent.click(await card(dlg, /Send for RMA/));
    await userEvent.type(within(dlg).getByLabelText(/^Note/), 'Back to the vendor');
    await nextStep(dlg);
    await userEvent.click(await card(dlg, 'Leave it empty'));
    await nextStep(dlg);
    expect(within(dlg).getByText(/is sent for RMA/)).toBeInTheDocument();
    await confirmMove(dlg);
    await waitFor(() => expect(moves(calls)).toHaveLength(1));
    expect(moves(calls)[0]!.body).toEqual({
      destination: { kind: 'rma', note: 'Back to the vendor' },
      date: expect.stringMatching(DATE),
    });
  });

  it('R73, R70: another bay shows the grids with the current bay disabled; an empty bay adds no occupant step', async () => {
    const calls = setupServer();
    const dlg = await openMove();
    await userEvent.click(await card(dlg, /Another bay/));
    await nextStep(dlg);
    expect(within(dlg).getByText(/Step 2 of 4 · Which bay\?/)).toBeInTheDocument();
    const current = within(dlg).getByRole('radio', {
      name: 'Front bays, Bay 3, current bay, occupied by CCC2',
    });
    expect(current).toBeDisabled();
    expect(within(current).getByText('Current')).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: 'Next' })).toBeDisabled();
    await pickSlot(within(dlg), /Bay 2, empty/);
    expect(within(dlg).getByText(/Step 2 of 4 · Which bay\?/)).toBeInTheDocument();
    await nextStep(dlg);
    expect(within(dlg).getByText(/Step 3 of 4 · What goes into this bay\?/)).toBeInTheDocument();
    await userEvent.click(await card(dlg, 'Leave it empty'));
    await nextStep(dlg);
    expect(dlg.querySelector('.step-content')).toHaveTextContent(
      /CCC2 \(4 TB\) moves from Front bays, Bay 3 to Front bays, Bay 2 and keeps its pool membership/,
    );
    await confirmMove(dlg);
    await waitFor(() => expect(moves(calls)).toHaveLength(1));
    expect(moves(calls)[0]!.body).toEqual({
      destination: { kind: 'slot', slotId: 's1' },
      date: expect.stringMatching(DATE),
    });
  });

  it('R73, R37, R62: an occupied bay adds the occupant step; retiring it needs a reason (no preset)', async () => {
    const calls = setupServer();
    const dlg = await openMove();
    await userEvent.click(await card(dlg, /Another bay/));
    await nextStep(dlg);
    await pickSlot(within(dlg), /Bay 1, occupied by AAA0/);
    expect(within(dlg).getByText(/Step 2 of 5 · Which bay\?/)).toBeInTheDocument();
    await nextStep(dlg);
    expect(
      within(dlg).getByText(/Step 3 of 5 · What happens to the drive in that bay\?/),
    ).toBeInTheDocument();
    expect(within(dlg).getAllByText(/AAA0/).length).toBeGreaterThan(0);
    await userEvent.click(await card(dlg, /^Retire/));
    expect(within(dlg).getByRole('button', { name: 'Next' })).toBeDisabled();
    await userEvent.click(field(within(dlg), /^Reason/));
    await userEvent.click(await screen.findByRole('option', { name: 'Replaced', hidden: true }));
    await nextStep(dlg);
    // Step "what goes into this bay" still applies to the bay being vacated.
    expect(within(dlg).getByText(/What goes into this bay\?/)).toBeInTheDocument();
    await userEvent.click(await card(dlg, /A spare/));
    await userEvent.click(await within(dlg).findByRole('radio', { name: /SPARE8/ }));
    await nextStep(dlg);
    await nextStep(dlg);
    expect(dlg.querySelector('.step-content')).toHaveTextContent(
      /AAA0 is retired \(replaced\) first/,
    );
    await confirmMove(dlg);
    await waitFor(() => expect(moves(calls)).toHaveLength(1));
    expect(moves(calls)[0]!.body).toEqual({
      destination: {
        kind: 'slot',
        slotId: 's0',
        occupant: { action: 'retire', reason: 'replaced', note: null },
      },
      replacement: { driveId: 'd8', poolId: 'p1', role: 'hot-spare' },
      date: expect.stringMatching(DATE),
    });
  });

  it('R73, R37: the occupant can go back to the spares (no extra date field) or to RMA', async () => {
    const calls = setupServer();
    const dlg = await openMove();
    await userEvent.click(await card(dlg, /Another bay/));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Clear' }));
    await nextStep(dlg);
    await pickSlot(within(dlg), /Bay 1, occupied by AAA0/);
    await nextStep(dlg);
    expect(within(dlg).queryByLabelText(/date|when/i)).not.toBeInTheDocument();
    await userEvent.click(await card(dlg, 'Send for RMA'));
    await nextStep(dlg);
    await userEvent.click(await card(dlg, 'Leave it empty'));
    await nextStep(dlg);
    await confirmMove(dlg);
    await waitFor(() => expect(moves(calls)).toHaveLength(1));
    expect(moves(calls)[0]!.body).toMatchObject({
      destination: { kind: 'slot', slotId: 's0', occupant: { action: 'rma', note: null } },
      date: null,
    });
  });

  it('R73, R37: a 409 for an occupied bay asks what to do with its drive, then repeats the call', async () => {
    const { slots, drives } = fixtureData();
    // The layout still shows Bay 4 as empty although a drive is in it by now.
    const calls = setupServer(
      {
        'POST /api/drives/d2/move': (body: unknown) => {
          const dest = (body as { destination: { occupant?: unknown } }).destination;
          return dest.occupant
            ? new Response(JSON.stringify({ drive: drives[1] }), { status: 200 })
            : new Response(
                JSON.stringify({
                  error: {
                    code: 'conflict',
                    message: 'Slot Bay 4 is occupied by ZZZ',
                    details: { occupant: { driveId: 'd0', serial: 'AAA0' } },
                  },
                }),
                { status: 409 },
              );
        },
      },
      { slots, drives },
    );
    const dlg = await openMove();
    await userEvent.click(await card(dlg, /Another bay/));
    await nextStep(dlg);
    await pickSlot(within(dlg), /Bay 4, empty/);
    await nextStep(dlg);
    await userEvent.click(await card(dlg, 'Leave it empty'));
    await nextStep(dlg);
    await confirmMove(dlg);
    expect(
      await within(dlg).findByText(/What happens to the drive in that bay\?/),
    ).toBeInTheDocument();
    expect(moves(calls)).toHaveLength(1);
    await nextStep(dlg); // spare is preselected
    await nextStep(dlg);
    await confirmMove(dlg);
    await waitFor(() => expect(moves(calls)).toHaveLength(2));
    expect(moves(calls)[1]!.body).toMatchObject({
      destination: { kind: 'slot', slotId: 's3', occupant: { action: 'spare' } },
    });
  });

  it('R73, R37: swapping is the first occupant option, skips the fill step and sends one swap POST', async () => {
    const calls = setupServer();
    const dlg = await openMove();
    await userEvent.click(await card(dlg, /Another bay/));
    await nextStep(dlg);
    await pickSlot(within(dlg), /Bay 1, occupied by AAA0/);
    await nextStep(dlg);
    const options = within(dlg).getAllByRole('radio');
    expect(options[0]).toHaveTextContent(/^Swap — put AAA0 into /);
    await userEvent.click(options[0]!);
    await nextStep(dlg);
    expect(within(dlg).queryByText(/What goes into this bay\?/)).not.toBeInTheDocument();
    expect(within(dlg).getByText(/Step 4 of 4 · Confirm/)).toBeInTheDocument();
    expect(dlg.querySelector('.step-content')).toHaveTextContent(/⇄.*CCC2.*and AAA0.*swap places/);
    await confirmMove(dlg);
    await waitFor(() => expect(moves(calls)).toHaveLength(1));
    expect(moves(calls)[0]!.body).toEqual({
      destination: { kind: 'slot', slotId: 's0', occupant: { action: 'swap' } },
      date: expect.stringMatching(DATE),
    });
  });

  it('R73: a server error shows inline in the confirm step and the dialog stays open', async () => {
    const calls = setupServer({
      'POST /api/drives/d2/move': () =>
        errorResponse(400, 'invalid', "A drive can't be moved before it was installed."),
    });
    const dlg = await openMove();
    await toConfirm(dlg, /Spares shelf/);
    await confirmMove(dlg);
    expect(
      await within(dlg).findByText(/can't be moved before it was installed/),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Move CCC2' })).toBeInTheDocument();
    expect(moves(calls)).toHaveLength(1);
  });

  it('R73: Back keeps the answers of earlier steps', async () => {
    setupServer();
    const dlg = await openMove();
    await userEvent.click(await card(dlg, /Another bay/));
    await nextStep(dlg);
    await pickSlot(within(dlg), /Bay 2, empty/);
    await nextStep(dlg);
    await userEvent.click(await within(dlg).findByRole('button', { name: 'Back' }));
    expect(within(dlg).getByRole('radio', { name: /Bay 2, empty/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await userEvent.click(within(dlg).getByRole('button', { name: 'Back' }));
    expect(await card(dlg, /Another bay/)).toHaveAttribute('aria-checked', 'true');
    expect(within(dlg).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });
});

describe('Spare and retired history (owner request)', () => {
  it('a spares-shelf row opens the drive drawer with its History; Assign stays separate', async () => {
    setupServer({
      'GET /api/drives/d9/history': [
        act('drive-added', '2026-03-01T09:00:00.000Z', null, [
          ev('drive-created', { drive: ['d9', 'SPARE9'] }),
        ]),
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
    const d0: [string, string] = ['d0', 'AAA0'];
    const slot: [string, string, string] = ['s0', 'Bay 1', 'Front bays'];
    const out = (at: string, on: string | null) =>
      act('removed', at, on, [
        ev('drive-uninstalled', {
          drive: d0,
          slot,
          payload: { installedOn: null, poolRole: null },
        }),
      ]);
    const into = (at: string, on: string) =>
      act('assigned', at, on, [
        ev('drive-installed', { drive: d0, slot, payload: { poolRole: null } }),
      ]);
    setupServer({
      'GET /api/drives/d0/history': [
        out('2026-10-11T09:00:00.000Z', null),
        into('2026-06-01T09:00:00.000Z', '2026-06-01'),
        out('2026-05-20T09:00:00.000Z', '2026-05-01'),
        into('2025-01-01T09:00:00.000Z', '2025-01-01'),
        act('drive-added', '2024-12-01T09:00:00.000Z', null, [ev('drive-created', { drive: d0 })]),
      ],
    });
    renderApp(<App />);
    const panel = await openSlotPanel(/^Bay 1, /);
    const story = await within(panel).findByRole('region', { name: 'Life story' });
    expect(
      await within(story).findByText(
        /Removed from Front bays, Bay 1 \(removal date not recorded\)/,
      ),
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
