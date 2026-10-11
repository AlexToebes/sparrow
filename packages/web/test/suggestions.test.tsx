import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../src/App';
import { buildStory } from '../src/lib/lifeStory';
import { errorResponse, posts, setupServer } from './server';
import { makeDrive, renderApp } from './utils';

const provider = {
  providerId: 'scrutiny',
  reachable: true,
  lastSuccessAt: new Date().toISOString(),
  lastAttemptAt: new Date().toISOString(),
  lastError: null,
  observationCount: 3,
};
const inboxOf = (count: number) => ({
  entries: [],
  unidentified: [],
  retiredCandidates: [],
  count,
});
const fill = {
  field: 'capacityBytes',
  kind: 'fill',
  current: null,
  suggested: 8e12,
} as const;
const model = { field: 'model', kind: 'fill', current: null, suggested: 'WDC WD80' } as const;
const differs = { field: 'driveType', kind: 'differs', current: 'HDD', suggested: 'SSD' } as const;

/** AAA0 is manually added and matched (suggestions); the fixture's CCC2 has none. */
const driveSetup = (extra: Parameters<typeof setupServer>[0] = {}) =>
  setupServer({
    'GET /api/provider/status': provider,
    'GET /api/suggestions': {
      byDriveId: { d0: { fill: 2, differs: 1, fillFields: ['model', 'capacityBytes'] } },
    },
    'GET /api/drives/d0/suggestions': { suggestions: [model, fill, differs] },
    'GET /api/drives/d0/events': [],
    ...extra,
  });

describe('Discovered button on the Drives page (R71)', () => {
  it('R71: shows a Discovered button with the count next to Add drive; it opens /drives/discovered', async () => {
    setupServer({ 'GET /api/inbox': inboxOf(3), 'GET /api/provider/status': provider });
    renderApp(<App />, '/drives');
    const link = await screen.findByRole('link', { name: /Discovered/ });
    expect(link).toHaveAttribute('href', '/drives/discovered');
    expect(await within(link).findByLabelText('3 discovered')).toHaveTextContent('3');
    expect(screen.getByRole('button', { name: 'Add drive' })).toBeInTheDocument();

    await userEvent.click(link);
    expect(await screen.findByRole('heading', { name: 'Discovered drives' })).toBeInTheDocument();
    expect(document.querySelector('a.back-link')).toHaveAttribute('href', '/drives');
    // The Drives nav item stays highlighted on the Discovered page
    const nav = screen.getAllByRole('navigation', { name: 'Main' })[0]!;
    expect(within(nav).getByRole('link', { name: 'Drives' })).toHaveClass('active');
  });

  it('R71: the button is quiet (no badge) when nothing is discovered', async () => {
    setupServer({ 'GET /api/provider/status': provider });
    renderApp(<App />, '/drives');
    const link = await screen.findByRole('link', { name: /Discovered/ });
    expect(within(link).queryByLabelText(/discovered/)).not.toBeInTheDocument();
  });

  it.each(['/inbox', '/drives/inbox'])(
    'R71: the old %s address redirects to /drives/discovered and the back link returns to Drives',
    async (old) => {
      setupServer({ 'GET /api/provider/status': provider });
      renderApp(<App />, old);
      expect(await screen.findByRole('heading', { name: 'Discovered drives' })).toBeInTheDocument();
      const back = document.querySelector('a.back-link')!;
      await userEvent.click(back);
      expect(await screen.findByRole('button', { name: 'Add drive' })).toBeInTheDocument();
    },
  );
});

describe('Suggested updates (R72)', () => {
  it('R72: the Drives list flags rows that have fill suggestions, with text and not colour alone', async () => {
    driveSetup();
    renderApp(<App />, '/drives');
    const row = (await screen.findByText('AAA0')).closest('tr')!;
    expect(within(row).getByText('Updates')).toBeInTheDocument();
    const other = screen.getByText('SPARE9').closest('tr')!;
    expect(within(other).queryByText('Updates')).not.toBeInTheDocument();
  });

  it('R72: differs-only suggestions do not raise the list indicator', async () => {
    driveSetup({
      'GET /api/suggestions': { byDriveId: { d0: { fill: 0, differs: 1, fillFields: [] } } },
    });
    renderApp(<App />, '/drives');
    await screen.findByText('AAA0');
    expect(screen.queryByText('Updates')).not.toBeInTheDocument();
  });

  it('R72: the Discovered page lists drives with fill suggestions, naming the fields, linking to the drive', async () => {
    driveSetup();
    renderApp(<App />, '/drives/discovered');
    const section = await screen.findByRole('region', { name: 'Suggested updates' });
    expect(within(section).getByText(/can add model, capacity/)).toBeInTheDocument();
    const link = within(section).getByRole('link', { name: 'AAA0' });
    expect(link).toHaveAttribute('href', '/drives?drive=d0');
    await userEvent.click(link);
    expect(await screen.findByRole('region', { name: 'Suggested updates' })).toBeInTheDocument();
  });

  it('R72: no Suggested updates section on the Discovered page when nothing can be filled', async () => {
    setupServer({ 'GET /api/provider/status': provider });
    renderApp(<App />, '/drives/discovered');
    await screen.findByRole('heading', { name: 'Discovered drives' });
    expect(screen.queryByRole('region', { name: 'Suggested updates' })).not.toBeInTheDocument();
  });

  async function openDetail() {
    renderApp(<App />, '/drives?drive=d0');
    const section = await screen.findByRole('region', { name: 'Suggested updates' });
    return within(section);
  }

  it('R72: the detail section names the provider, shows current → suggested (D4) and applies only the ticked fields', async () => {
    const calls = driveSetup({
      'POST /api/drives/d0/suggestions/apply': makeDrive({ id: 'd0', serial: 'AAA0' }),
    });
    const s = await openDetail();
    expect(s.getByText("Scrutiny reports details this record doesn't have")).toBeInTheDocument();
    expect(s.getByText('8 TB')).toBeInTheDocument(); // capacity formatted in decimal units
    expect(s.getByText('WDC WD80')).toBeInTheDocument();
    expect(s.getAllByText('not recorded')).toHaveLength(2);
    // "fill" rows start ticked; the differing value is collapsed and nothing is applied yet
    expect(s.queryByText('SSD')).not.toBeInTheDocument();
    expect(posts(calls, '/api/drives/d0/suggestions/apply')).toHaveLength(0);

    await userEvent.click(s.getByRole('checkbox', { name: /Model/ }));
    await userEvent.click(s.getByRole('button', { name: 'Apply selected' }));
    await waitFor(() => expect(posts(calls, '/api/drives/d0/suggestions/apply')).toHaveLength(1));
    expect(posts(calls, '/api/drives/d0/suggestions/apply')[0]!.body).toEqual({
      fields: ['capacityBytes'],
    });
  });

  it('R72: "reports different values" is collapsed, unticked by default, and can be applied on request', async () => {
    const calls = driveSetup({
      'POST /api/drives/d0/suggestions/apply': makeDrive({ id: 'd0', serial: 'AAA0' }),
    });
    const s = await openDetail();
    const toggle = s.getByRole('button', { name: /Scrutiny reports different values \(1\)/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    const box = s.getByRole('checkbox', { name: /Type/ });
    expect(box).not.toBeChecked();
    expect(s.getByText('SSD')).toBeInTheDocument();
    await userEvent.click(box);
    await userEvent.click(s.getByRole('button', { name: 'Apply selected' }));
    await waitFor(() => expect(posts(calls, '/api/drives/d0/suggestions/apply')).toHaveLength(1));
    expect(posts(calls, '/api/drives/d0/suggestions/apply')[0]!.body).toEqual({
      fields: ['model', 'capacityBytes', 'driveType'],
    });
  });

  it('R72: a failed apply (stale suggestion) shows the server message inline', async () => {
    driveSetup({
      'POST /api/drives/d0/suggestions/apply': () =>
        errorResponse(409, 'conflict', 'The suggestion for model no longer applies'),
    });
    const s = await openDetail();
    await userEvent.click(s.getByRole('button', { name: 'Apply selected' }));
    expect(await s.findByRole('alert')).toHaveTextContent('no longer applies');
  });

  it('R72: a drive without suggestions shows no section', async () => {
    driveSetup({ 'GET /api/drives/d0/suggestions': { suggestions: [] } });
    renderApp(<App />, '/drives?drive=d0');
    await screen.findByRole('heading', { name: 'AAA0' });
    expect(screen.queryByRole('region', { name: 'Suggested updates' })).not.toBeInTheDocument();
  });

  it('R72: the section uses a generic name when the provider id is none', async () => {
    driveSetup({ 'GET /api/provider/status': { ...provider, providerId: 'none' } });
    const s = await openDetail();
    expect(
      s.getByText("The provider reports details this record doesn't have"),
    ).toBeInTheDocument();
  });

  it('R72: the life story reads "Details updated from the provider: model, capacity"', () => {
    const story = buildStory([
      {
        id: 'e1',
        driveId: 'd0',
        type: 'drive-updated',
        at: '2026-03-01T10:00:00.000Z',
        payload: {
          source: 'provider',
          changes: { model: { from: null, to: 'M' }, capacityBytes: { from: null, to: 1 } },
        },
      },
    ]);
    expect(story[0]!.title).toBe('Details updated from the provider: model, capacity');
    const manual = buildStory([
      {
        id: 'e2',
        driveId: 'd0',
        type: 'drive-updated',
        at: '2026-03-01T10:00:00.000Z',
        payload: { changes: { model: { from: null, to: 'M' } } },
      },
    ]);
    expect(manual[0]!.title).toBe('Details edited');
  });

  it('R72: Dismiss on a row and Dismiss selected post the fields without a confirmation', async () => {
    const calls = driveSetup({
      'POST /api/drives/d0/suggestions/dismiss': () => new Response(null, { status: 204 }),
    });
    const s = await openDetail();
    await userEvent.click(s.getByRole('button', { name: 'Dismiss model suggestion' }));
    await waitFor(() => expect(posts(calls, '/api/drives/d0/suggestions/dismiss')).toHaveLength(1));
    expect(posts(calls, '/api/drives/d0/suggestions/dismiss')[0]!.body).toEqual({
      fields: ['model'],
    });
    await userEvent.click(s.getByRole('checkbox', { name: /Model/ })); // untick model
    await userEvent.click(s.getByRole('button', { name: 'Dismiss selected' }));
    await waitFor(() => expect(posts(calls, '/api/drives/d0/suggestions/dismiss')).toHaveLength(2));
    expect(posts(calls, '/api/drives/d0/suggestions/dismiss')[1]!.body).toEqual({
      fields: ['capacityBytes'],
    });
  });

  it('R72: dismissed suggestions sit behind "N dismissed — show", with Undo posting to undismiss', async () => {
    const calls = driveSetup({
      'GET /api/drives/d0/suggestions': { suggestions: [fill], dismissed: [model] },
      'POST /api/drives/d0/suggestions/undismiss': () => new Response(null, { status: 204 }),
    });
    const s = await openDetail();
    expect(s.queryByText('WDC WD80')).not.toBeInTheDocument();
    const toggle = s.getByRole('button', { name: '1 dismissed — show' });
    await userEvent.click(toggle);
    expect(s.getByText('WDC WD80')).toBeInTheDocument();
    await userEvent.click(s.getByRole('button', { name: 'Undo dismissing model suggestion' }));
    await waitFor(() =>
      expect(posts(calls, '/api/drives/d0/suggestions/undismiss')).toHaveLength(1),
    );
    expect(posts(calls, '/api/drives/d0/suggestions/undismiss')[0]!.body).toEqual({
      fields: ['model'],
    });
  });

  it('R72: the section still shows the dismissed toggle when only dismissed suggestions remain', async () => {
    driveSetup({ 'GET /api/drives/d0/suggestions': { suggestions: [], dismissed: [model] } });
    const s = await openDetail();
    expect(s.getByRole('button', { name: '1 dismissed — show' })).toBeInTheDocument();
    expect(s.queryByRole('button', { name: 'Apply selected' })).not.toBeInTheDocument();
  });

  it('R72: the life story reads "Dismissed suggested model \'...\'" and "Restored suggestion for model"', () => {
    const at = '2026-03-01T10:00:00.000Z';
    const story = buildStory([
      {
        id: 'e2',
        driveId: 'd0',
        type: 'suggestion-dismissed',
        at: '2026-03-02T10:00:00.000Z',
        payload: { field: 'model', value: null },
      },
      {
        id: 'e1',
        driveId: 'd0',
        type: 'suggestion-dismissed',
        at,
        payload: { field: 'model', value: 'WDC WD80EFZX' },
      },
    ]);
    const titles = story.map((i) => i.title);
    expect(titles).toContain("Dismissed suggested model 'WDC WD80EFZX'");
    expect(titles).toContain('Restored suggestion for model');
  });
});
