import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from './user';
import { App } from '../src/App';
import { act, ev } from './activities';
import { renderApp } from './utils';
import { setupServer } from './server';

afterEach(() => vi.restoreAllMocks());

const R = '2026-10-11T12:00:00.000Z';
const reinstated = (seq: number, serial: string) =>
  act('reinstated', R, null, [ev('drive-reinstated', { drive: [`d${seq}`, serial] })], { seq });

describe('R75: recent changes on the Layout page', () => {
  it('R75: shows the latest five as one sentence each, with links and a Show all link', async () => {
    const replaced = act(
      'replaced',
      R,
      '2026-10-10',
      [
        ev('drive-uninstalled', { drive: ['d2', 'ZL2ABC03'], slot: ['s2', 'Bay 3', 'Front bays'] }),
        ev('drive-retired', { drive: ['d2', 'ZL2ABC03'], payload: { reason: 'failed' } }),
        ev('drive-installed', {
          drive: ['d9', 'ZL2SPR01', 8e12],
          slot: ['s2', 'Bay 3', 'Front bays'],
        }),
      ],
      { seq: 20 },
    );
    setupServer({ 'GET /api/activities/recent?limit=5': [replaced, reinstated(19, 'ZL19')] });
    renderApp(<App />, '/');
    const card = await screen.findByRole('region', { name: 'Recent changes' });
    const list = await within(card).findByRole('list', { name: 'Recent changes list' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!).toHaveTextContent(
      'ZL2SPR01 (8 TB) replaced ZL2ABC03 in Front bays, Bay 3 · ZL2ABC03 retired (failed)',
    );
    expect(items[0]!).toHaveTextContent('2026-10-10');
    expect(items[0]!).toHaveTextContent('recorded');
    expect(within(items[0]!).getAllByRole('link', { name: 'ZL2ABC03' })[0]).toHaveAttribute(
      'href',
      '/drives?drive=d2',
    );
    expect(
      within(items[0]!).getAllByRole('link', { name: 'Front bays, Bay 3' })[0],
    ).toHaveAttribute('href', '/?slot=s2&view=slot');
    expect(items[1]!).toHaveTextContent('ZL19 reinstated as a spare');
    expect(within(card).getByRole('link', { name: 'Show all' })).toHaveAttribute(
      'href',
      '/activity',
    );
  });

  it('R75: says so when nothing has happened yet', async () => {
    setupServer();
    renderApp(<App />, '/');
    const card = await screen.findByRole('region', { name: 'Recent changes' });
    expect(await within(card).findByText('Nothing has happened yet.')).toBeInTheDocument();
  });

  it('R75: Show all opens the full list', async () => {
    setupServer({
      'GET /api/activities/recent?limit=5': [reinstated(3, 'ZL3')],
      'GET /api/activities/recent?limit=30': [reinstated(3, 'ZL3')],
    });
    renderApp(<App />, '/');
    await userEvent.click(await screen.findByRole('link', { name: 'Show all' }));
    expect(
      await screen.findByRole('heading', { name: 'Recent changes', level: 1 }),
    ).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'All changes list' });
    expect(within(list).getByRole('listitem')).toHaveTextContent('ZL3 reinstated as a spare');
  });
});

describe('R75: the /activity page', () => {
  it('R75: Load more pages with the oldest seq as the exclusive cursor and stops on a short page', async () => {
    const first = Array.from({ length: 30 }, (_, i) => reinstated(60 - i, `NEW${60 - i}`));
    const second = [reinstated(30, 'OLD30'), reinstated(29, 'OLD29')];
    const calls = setupServer({
      'GET /api/activities/recent?limit=30': first,
      'GET /api/activities/recent?limit=30&before=31': second,
    });
    renderApp(<App />, '/activity');
    const list = await screen.findByRole('list', { name: 'All changes list' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(30);
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await within(list).findByText('OLD29');
    expect(within(list).getAllByRole('listitem')).toHaveLength(32);
    expect(calls.map((c) => c.url)).toContain('/api/activities/recent?limit=30&before=31');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('R75: shows the empty state', async () => {
    setupServer({ 'GET /api/activities/recent?limit=30': [] });
    renderApp(<App />, '/activity');
    expect(await screen.findByText('Nothing has happened yet.')).toBeInTheDocument();
  });

  it('R75: is reachable from Settings and is not a nav item', async () => {
    setupServer();
    renderApp(<App />, '/settings');
    expect(await screen.findByRole('link', { name: 'Recent changes' })).toHaveAttribute(
      'href',
      '/activity',
    );
    const nav = screen.getAllByRole('navigation')[0]!;
    expect(within(nav).queryByRole('link', { name: /recent changes|activity/i })).toBeNull();
  });
});
