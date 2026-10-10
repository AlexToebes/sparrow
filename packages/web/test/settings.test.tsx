import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../src/App';
import { makeDrive, makeSlot, renderApp } from './utils';

const T = '2026-01-01T00:00:00.000Z';
type Handler = (init: RequestInit | undefined) => { status?: number; body?: unknown };

function layout() {
  return {
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
  };
}

const calls: { method: string; url: string; body: unknown }[] = [];

function mock(extra: Record<string, Handler> = {}) {
  const base: Record<string, Handler> = {
    'GET /api/layout': () => ({ body: layout() }),
    'GET /api/drives': () => ({ body: [makeDrive({ id: 'd0', serial: 'SER-0', slotId: 's0' })] }),
    'GET /api/inbox': () => ({ body: { count: 0, items: [] } }),
    'GET /api/provider/status': () => ({
      body: {
        providerId: 'scrutiny',
        reachable: true,
        lastSuccessAt: new Date().toISOString(),
        lastAttemptAt: new Date().toISOString(),
        lastError: null,
        observationCount: 1,
      },
    }),
    'GET /api/status': () => ({ body: { providerStale: false, staleAfterHours: 1.5, slots: [] } }),
    'GET /api/config': () => ({
      body: {
        provider: 'scrutiny',
        pollIntervalMinutes: 5,
        staleAfterHours: 1.5,
        dataDir: '/data',
        backupDir: '/data/exports',
      },
    }),
    ...extra,
  };
  calls.length = 0;
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const h = base[`${method} ${url}`];
    const r = h
      ? h(init)
      : {
          status: 404,
          body: { error: { code: 'not-found', message: `no mock ${method} ${url}` } },
        };
    const status = r.status ?? 200;
    return Promise.resolve(
      new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), { status }),
    );
  }) as typeof fetch;
}

afterEach(() => vi.restoreAllMocks());

const exportFile = JSON.stringify({
  format: 'sparrow-export',
  schemaVersion: 1,
  data: {
    drives: [{}, {}, {}],
    enclosures: [{}],
    grids: [{}],
    slots: [{}, {}],
    pools: [],
    events: [],
  },
});

async function pickFile(content: string, name = 'backup.json') {
  const user = userEvent.setup();
  const input = await screen.findByTestId('import-file');
  await user.upload(input, new File([content], name, { type: 'application/json' }));
  return user;
}

describe('R43, R44: import UI', () => {
  it('R44: sends nothing until the confirmation dialog is accepted', async () => {
    mock({
      'POST /api/import': () => ({
        body: {
          backupPath: '/data/exports/pre-import.json',
          counts: { drives: 3, enclosures: 1, grids: 1, slots: 2, pools: 0, events: 0 },
        },
      }),
    });
    renderApp(<App />, '/settings');
    const user = await pickFile(exportFile);
    const dialog = await screen.findByRole('dialog', { name: /replace all data/i });
    expect(dialog).toHaveTextContent('/data/exports');
    expect(dialog).toHaveTextContent('1 drive');
    expect(dialog).toHaveTextContent('3 drives');
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/import')).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.url === '/api/import')).toBe(false);

    await user.upload(screen.getByTestId('import-file'), new File([exportFile], 'backup.json'));
    await user.click(await screen.findByRole('button', { name: 'Replace all data' }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('/data/exports/pre-import.json');
    expect(status).toHaveTextContent('3 drives');
    expect(calls.filter((c) => c.url === '/api/import')).toHaveLength(1);
  });

  it('R43: a file that is not JSON is rejected before any request', async () => {
    mock();
    renderApp(<App />, '/settings');
    await pickFile('this is not json');
    expect(await screen.findByText(/not valid JSON/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((c) => c.url === '/api/import')).toBe(false);
  });

  it('R43: shows the API message for a newer schema version', async () => {
    const message =
      'This export was made by a newer Sparrow (schema 2); this version supports up to 1.';
    mock({
      'POST /api/import': () => ({ status: 400, body: { error: { code: 'invalid', message } } }),
    });
    renderApp(<App />, '/settings');
    const user = await pickFile(exportFile);
    await user.click(await screen.findByRole('button', { name: 'Replace all data' }));
    expect(await screen.findByText(message)).toBeVisible();
  });
});

describe('R38, R40: layout editor', () => {
  it('R40: a blocked shrink lists the occupied slots', async () => {
    mock({
      'PATCH /api/grids/g1': () => ({
        status: 409,
        body: {
          error: {
            code: 'conflict',
            message:
              'Resizing "Front bays" is blocked: occupied slots would be removed. Resolve their drives first.',
            details: {
              occupied: [
                {
                  slotId: 's0',
                  gridId: 'g1',
                  gridName: 'Front bays',
                  position: 0,
                  label: 'Bay 1',
                  driveId: 'd0',
                },
              ],
            },
          },
        },
      }),
    });
    renderApp(<App />, '/settings');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit grid' }));
    const cols = screen.getByLabelText('Columns');
    await user.clear(cols);
    await user.type(cols, '1');
    await user.click(screen.getByRole('button', { name: 'Save grid' }));
    const list = await screen.findByRole('list', { name: 'Occupied slots' });
    expect(list).toHaveTextContent('Front bays, Bay 1');
    expect(list).toHaveTextContent('SER-0');
    expect(screen.getByRole('alert')).toHaveTextContent(/Resizing .* is blocked/);
    expect(calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({ columns: 1, rows: 1 });
  });

  it('R38, R39: saving a slot label sends the new label', async () => {
    mock({ 'PATCH /api/slots/s1': () => ({ body: {} }) });
    renderApp(<App />, '/settings');
    const user = userEvent.setup();
    const input = await screen.findByLabelText('Label for slot 2');
    await user.clear(input);
    await user.type(input, 'Cache{Enter}');
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/slots/s1')?.body).toEqual({ label: 'Cache' }),
    );
  });

  it('R38: adds a grid to an enclosure', async () => {
    mock({ 'POST /api/enclosures/e1/grids': () => ({ status: 201, body: {} }) });
    renderApp(<App />, '/settings');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add grid' }));
    await user.type(screen.getByLabelText('Grid name'), 'Internal');
    await user.click(screen.getAllByRole('button', { name: 'Add grid' }).at(-1)!);
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/enclosures/e1/grids')?.body).toEqual({
        name: 'Internal',
        rows: 2,
        columns: 4,
        orientation: 'landscape',
      }),
    );
  });
});

describe('R41: export and configuration', () => {
  it('links export to the API and shows the effective config', async () => {
    mock();
    renderApp(<App />, '/settings');
    const link = await screen.findByRole('link', { name: 'Export data' });
    expect(link).toHaveAttribute('href', '/api/export');
    expect(await screen.findByText('1.5 h')).toBeInTheDocument();
    expect(screen.getByText('5 min')).toBeInTheDocument();
    expect(screen.getByText('Reachable')).toBeInTheDocument();
  });
});
