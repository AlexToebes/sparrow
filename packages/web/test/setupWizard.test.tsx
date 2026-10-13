import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from './user';
import { App } from '../src/App';
import { LayoutEditor } from '../src/components/LayoutEditor';
import { setupServer, posts } from './server';
import { renderApp } from './utils';

// R5 (changed 2026-10-13) and R77: the first-run setup wizard.

const CREATED = { enclosureId: 'e9', gridIds: ['g9'], poolIds: [] };
const NO_ENCLOSURE = { layoutGrids: [], slots: [], drives: [] };

function start(
  state: 'needed' | 'skipped' | 'done' = 'needed',
  extra: Record<string, unknown> = {},
) {
  return setupServer(
    {
      'GET /api/setup': { state },
      'POST /api/setup': () => new Response(JSON.stringify(CREATED), { status: 201 }),
      'POST /api/setup/skip': { state: 'skipped' },
      ...extra,
    },
    NO_ENCLOSURE,
  );
}

const dialog = async () => within(await screen.findByRole('dialog'));
const press = async (root: ReturnType<typeof within>, name: string | RegExp) =>
  userEvent.click(await root.findByRole('button', { name }));
const nextStep = async (root: ReturnType<typeof within>) => {
  const button = await root.findByRole('button', { name: 'Next' });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
};

describe('R77: first-run setup wizard', () => {
  it('opens on a new install, walks every step and creates everything in one request', async () => {
    const calls = start();
    renderApp(<App />);
    const wizard = await dialog();
    expect(await wizard.findByText(/Step 1 of 6 · Welcome/)).toBeInTheDocument();
    expect(wizard.queryByText(/found/)).not.toBeInTheDocument();
    await press(wizard, 'Start');

    // Enclosure: the default name is NAS.
    expect(await wizard.findByText(/Step 2 of 6/)).toBeInTheDocument();
    const name = wizard.getByRole('textbox', { name: /Enclosure name/ });
    expect(name).toHaveValue('NAS');
    await userEvent.clear(name);
    await userEvent.type(name, 'Rack NAS');
    await nextStep(wizard);

    // Grids: Next is blocked until there is one.
    expect(await wizard.findByText(/Step 3 of 6/)).toBeInTheDocument();
    expect(wizard.getByRole('button', { name: 'Next' })).toBeDisabled();
    await press(wizard, /8 bays \(4 × 2\)/);
    await press(wizard, /2 internal SSDs \(2 × 1, Left\/Right\)/);
    expect(await wizard.findByRole('region', { name: 'Grid Front bays' })).toBeInTheDocument();
    expect(wizard.getByRole('region', { name: 'Grid Internal SSDs' })).toBeInTheDocument();

    // The preview is the real bay grid, 4 across and 2 down, with numbered bays; relabel one.
    const front = within(wizard.getByRole('region', { name: 'Grid Front bays' }));
    const cells = front.getAllByTestId('bay-cell');
    expect(cells).toHaveLength(8);
    expect(front.getByTestId('bay-grid')).toHaveAttribute('data-columns', '4');
    expect(front.getByTestId('bay-grid')).toHaveAttribute('data-rows', '2');
    const third = front.getByRole('textbox', { name: 'Label for bay 3 in Front bays' });
    expect(third).toHaveValue('3');
    await userEvent.clear(third);
    await userEvent.type(third, 'Top');
    const ssd = within(wizard.getByRole('region', { name: 'Grid Internal SSDs' }));
    expect(ssd.getByRole('textbox', { name: 'Label for bay 1 in Internal SSDs' })).toHaveValue(
      'Left',
    );
    expect(ssd.getByRole('textbox', { name: 'Label for bay 2 in Internal SSDs' })).toHaveValue(
      'Right',
    );
    await nextStep(wizard);

    // Pools are optional.
    expect(await wizard.findByText(/Step 4 of 6/)).toBeInTheDocument();
    await press(wizard, 'Skip this step');

    // Review, then create.
    expect(await wizard.findByText(/Step 5 of 6/)).toBeInTheDocument();
    expect(wizard.getByText('Rack NAS')).toBeInTheDocument();
    expect(wizard.getByText('Front bays')).toBeInTheDocument();
    expect(wizard.getByText(/No pools/)).toBeInTheDocument();
    expect(posts(calls, '/api/setup')).toHaveLength(0);
    await press(wizard, 'Create');

    expect(await wizard.findByText(/Step 6 of 6/)).toBeInTheDocument();
    const sent = posts(calls, '/api/setup');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({
      enclosureName: 'Rack NAS',
      grids: [
        {
          name: 'Front bays',
          rows: 2,
          columns: 4,
          orientation: 'landscape',
          labels: ['1', '2', 'Top', '4', '5', '6', '7', '8'],
        },
        {
          name: 'Internal SSDs',
          rows: 1,
          columns: 2,
          orientation: 'landscape',
          labels: ['Left', 'Right'],
        },
      ],
      pools: [],
    });
    expect(wizard.getByText(/Rack NAS is ready with 2 grids/)).toBeInTheDocument();
    // No provider drives: the next step is to add one.
    expect(wizard.getByRole('button', { name: 'Add a drive' })).toBeInTheDocument();
  });

  it('a custom grid takes its own size, name and orientation; pools are sent with it', async () => {
    const calls = start();
    renderApp(<App />);
    const wizard = await dialog();
    await press(wizard, 'Start');
    await nextStep(wizard);
    await press(wizard, /Custom/);
    const grid = within(await wizard.findByRole('region', { name: 'Grid Grid' }));
    const gridName = grid.getByRole('textbox', { name: 'Grid name' });
    await userEvent.clear(gridName);
    await userEvent.type(gridName, 'Hot swap');
    const columns = grid.getByRole('textbox', { name: 'Columns' });
    await userEvent.clear(columns);
    await userEvent.type(columns, '3');
    await userEvent.click(grid.getByRole('radio', { name: 'Portrait' }));
    // 3 columns x 2 rows stored, drawn portrait as 2 across and 3 down.
    expect(grid.getAllByTestId('bay-cell')).toHaveLength(6);
    expect(grid.getByTestId('bay-grid')).toHaveAttribute('data-columns', '2');
    await nextStep(wizard);

    await press(wizard, 'Add a pool');
    const pool = within(await wizard.findByRole('region', { name: /Pool/ }));
    await userEvent.type(pool.getByRole('textbox', { name: /Name/ }), 'tank');
    await userEvent.type(pool.getByRole('combobox', { name: /Layout label/ }), 'raidz2');
    await userEvent.type(pool.getByRole('textbox', { name: /Expected drives/ }), '6');
    // With a pool the step is no longer skipped.
    await nextStep(wizard);
    expect(await wizard.findByText(/6 drives expected/)).toBeInTheDocument();
    await press(wizard, 'Create');
    await wizard.findByText(/Step 6 of 6/);

    const body = posts(calls, '/api/setup')[0]!.body as Record<string, unknown>;
    expect(body.grids).toEqual([
      {
        name: 'Hot swap',
        rows: 2,
        columns: 3,
        orientation: 'portrait',
        labels: ['1', '2', '3', '4', '5', '6'],
      },
    ]);
    expect(body.pools).toEqual([{ name: 'tank', layoutLabel: 'raidz2', expectedMembers: 6 }]);
  });

  it('grids can be removed and reordered, and a duplicate name blocks Next', async () => {
    start();
    renderApp(<App />);
    const wizard = await dialog();
    await press(wizard, 'Start');
    await nextStep(wizard);
    await press(wizard, /4 bays \(4 × 1\)/);
    await press(wizard, /4 bays \(4 × 1\)/);
    // The second quick-add gets a free name.
    expect(await wizard.findByRole('region', { name: 'Grid Front bays 2' })).toBeInTheDocument();
    await press(wizard, 'Move Front bays 2 up');
    const titles = wizard.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual(['Front bays 2', 'Front bays']);

    const first = within(wizard.getByRole('region', { name: 'Grid Front bays 2' }));
    const gridName = first.getByRole('textbox', { name: 'Grid name' });
    await userEvent.clear(gridName);
    await userEvent.type(gridName, 'Front bays');
    expect((await wizard.findAllByText(/already named "Front bays"/)).length).toBeGreaterThan(0);
    expect(wizard.getByRole('button', { name: 'Next' })).toBeDisabled();

    await userEvent.click(first.getByRole('button', { name: /Remove/ }));
    await waitFor(() => expect(wizard.queryByText(/already named/)).not.toBeInTheDocument());
    expect(wizard.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('Back keeps what was typed', async () => {
    start();
    renderApp(<App />);
    const wizard = await dialog();
    await press(wizard, 'Start');
    await nextStep(wizard);
    await press(wizard, /12 bays/);
    await nextStep(wizard);
    await press(wizard, 'Back');
    expect(await wizard.findByRole('region', { name: 'Grid Front bays' })).toBeInTheDocument();
    await press(wizard, 'Back');
    expect(wizard.getByRole('textbox', { name: /Enclosure name/ })).toHaveValue('NAS');
  });

  it('"Skip, I\'ll set it up later" remembers the choice and leaves the empty state', async () => {
    const calls = start();
    renderApp(<App />);
    const wizard = await dialog();
    await press(wizard, /Skip, I'll set it up later/);
    await waitFor(() => expect(posts(calls, '/api/setup/skip')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(posts(calls, '/api/setup')).toHaveLength(0);
  });

  it('after a skip the Layout page shows an empty state with Set up now and a Settings link', async () => {
    start('skipped');
    renderApp(<App />);
    const empty = await screen.findByRole('region', { name: 'No enclosure yet' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(empty).getByRole('link', { name: /Settings/ })).toHaveAttribute(
      'href',
      '/settings',
    );
    await userEvent.click(within(empty).getByRole('button', { name: 'Set up now' }));
    const wizard = await dialog();
    expect(await wizard.findByText(/Step 1 of 6 · Welcome/)).toBeInTheDocument();
  });

  it('closing the wizard without skipping leaves a Start setup card', async () => {
    const calls = start();
    renderApp(<App />);
    await dialog();
    await userEvent.keyboard('{Escape}');
    const card = await screen.findByRole('region', { name: 'No enclosure yet' });
    expect(within(card).getByText('Welcome to Sparrow')).toBeInTheDocument();
    expect(posts(calls, '/api/setup/skip')).toHaveLength(0);
    expect(within(card).getByRole('button', { name: 'Start setup' })).toBeInTheDocument();
  });

  it('says how many drives the provider found and sends the user to Discovered at the end', async () => {
    start('needed', {
      'GET /api/provider/status': {
        providerId: 'scrutiny',
        reachable: true,
        lastSuccessAt: null,
        lastAttemptAt: null,
        lastError: null,
        observationCount: 9,
      },
      'GET /api/inbox': { entries: [], unidentified: [], retiredCandidates: [], count: 4 },
    });
    renderApp(<App />);
    const wizard = await dialog();
    expect(await wizard.findByText(/Scrutiny found 9 drives/)).toBeInTheDocument();
    await press(wizard, 'Start');
    await nextStep(wizard);
    await press(wizard, /1 boot drive/);
    expect(
      (await wizard.findByRole('textbox', {
        name: /Label for bay 1 in Boot drive/,
      })) as HTMLElement,
    ).toHaveValue('Boot');
    await nextStep(wizard);
    await press(wizard, 'Skip this step');
    await press(wizard, 'Create');
    expect(
      await wizard.findByText(/4 drives are waiting on the Discovered page/),
    ).toBeInTheDocument();
    expect(wizard.getByRole('button', { name: 'Open Discovered drives' })).toBeInTheDocument();
  });

  it('shows the server message and stays on Review when Create fails', async () => {
    start('needed', {
      'POST /api/setup': () =>
        new Response(
          JSON.stringify({ error: { code: 'conflict', message: 'Setup is not available' } }),
          { status: 409 },
        ),
    });
    renderApp(<App />);
    const wizard = await dialog();
    await press(wizard, 'Start');
    await nextStep(wizard);
    await press(wizard, /4 bays/);
    await nextStep(wizard);
    await press(wizard, 'Skip this step');
    await press(wizard, 'Create');
    expect(await wizard.findByText('Setup is not available')).toBeInTheDocument();
    expect(wizard.getByText(/Step 5 of 6/)).toBeInTheDocument();
  });

  it('Settings > Layout offers "Run setup wizard" while there is no enclosure', async () => {
    start('skipped');
    renderApp(<LayoutEditor />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run setup wizard' }));
    const wizard = await dialog();
    expect(await wizard.findByText(/Step 1 of 6/)).toBeInTheDocument();
  });

  it('does not offer the wizard when an enclosure exists', async () => {
    setupServer({ 'GET /api/setup': { state: 'done' } });
    renderApp(<LayoutEditor />);
    await screen.findByText('NAS');
    expect(screen.queryByRole('button', { name: 'Run setup wizard' })).not.toBeInTheDocument();
  });
});
