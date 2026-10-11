import { describe, expect, it } from 'vitest';
import type { DriveEvent } from '@sparrow/shared';
import { buildStory, summarizeStory } from '../src/lib/lifeStory';

let n = 0;
const ev = (
  type: DriveEvent['type'],
  at: string,
  payload: Record<string, unknown> = {},
): DriveEvent => ({ id: `e${++n}`, driveId: 'd1', type, at, payload });

// The API returns newest first; these helpers take them oldest first as they were logged.
const newestFirst = (...logged: DriveEvent[]) => [...logged].reverse();

const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const DAY = 86_400_000;

describe('life story with an unrecorded installation date (R68)', () => {
  const created = ev('drive-created', '2026-10-11T08:00:00.000Z');
  const installed = ev('drive-installed', '2026-10-11T09:00:00.000Z', {
    slotLabel: 'Bay 3',
    installedOn: null,
  });
  const events = newestFirst(created, installed);

  it('titles the install as not recorded and shows the logged day as its date', () => {
    const item = buildStory(events).find((s) => s.kind === 'drive-installed')!;
    expect(item.title).toBe('Installed in Bay 3 (installation date not recorded)');
    expect(item).toMatchObject({ unrecorded: true, recorded: null });
    expect(item.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('does not count in-service time from the recording date; flags it instead', () => {
    const sum = summarizeStory(events, NOW);
    expect(sum.inService).toBe(0);
    expect(sum.installUnrecorded).toBe(true);
    expect(sum.onShelf).toBe(60 * 60 * 1000);
  });

  it('counts in service again once a date is set by an edit, and labels the edit', () => {
    const edit = ev('drive-updated', '2026-10-11T10:00:00.000Z', {
      changes: { installedOn: { from: null, to: '2020-01-01' } },
    });
    const log = newestFirst(created, installed, edit);
    expect(buildStory(log).at(-1)!.title).toBe(
      'Installation date changed from not recorded to 2020-01-01',
    );
    const sum = summarizeStory(log, NOW);
    expect(sum.installUnrecorded).toBe(false);
    expect(sum.inService).toBe(NOW - Date.parse('2020-01-01T00:00:00.000Z'));
  });
});

describe('life story with a backdated installation (R68)', () => {
  const created = ev('drive-created', '2026-10-11T08:00:00.000Z');
  const joined = ev('pool-joined', '2026-10-11T09:00:00.000Z', {
    poolId: 'p1',
    role: 'data',
    startedAt: '2023-04-05T00:00:00.000Z',
  });
  const installed = ev('drive-installed', '2026-10-11T09:00:00.000Z', {
    slotLabel: 'Bay 3',
    gridName: 'Front bays',
    installedOn: '2023-04-05',
  });
  // Logged order as the server writes it: created, pool-joined, drive-installed.
  const events = newestFirst(created, joined, installed);

  it('orders by the effective date: installed, then joined the pool, then added to Sparrow', () => {
    const story = buildStory(events);
    expect(story.map((s) => s.kind)).toEqual(['drive-installed', 'pool-joined', 'drive-created']);
    expect(story[0]).toMatchObject({ date: '2023-04-05', recorded: expect.any(String) });
    expect(story[1]).toMatchObject({ date: '2023-04-05' });
    expect(story[2]!.recorded).toBeNull();
  });

  it('shows the recorded day only on backdated entries', () => {
    const story = buildStory(events);
    expect(story[0]!.recorded).toMatch(/^2026-10-1[01]$/);
    expect(story[2]!.recorded).toBeNull();
  });

  it('counts time in service from the installation date, not from when it was logged', () => {
    const sum = summarizeStory(events, NOW);
    const expected = NOW - Date.parse('2023-04-05T00:00:00.000Z');
    expect(sum.inService).toBe(expected);
    expect(sum.installUnrecorded).toBe(false);
    expect(sum.inService).toBeGreaterThan(1000 * DAY);
    expect(sum.onShelf).toBe(0);
  });

  it('labels an edit of the installation date and moves the in-service start', () => {
    const edit = ev('drive-updated', '2026-10-11T10:00:00.000Z', {
      changes: {
        installedOn: { from: '2023-04-05', to: '2020-01-01' },
        model: { from: 'a', to: 'b' },
      },
    });
    const withEdit = newestFirst(created, joined, installed, edit);
    const last = buildStory(withEdit).at(-1)!;
    expect(last.title).toBe('Installation date changed from 2023-04-05 to 2020-01-01');
    expect(last.detail).toBe('Also edited: model');
    expect(summarizeStory(withEdit, NOW).inService).toBe(
      NOW - Date.parse('2020-01-01T00:00:00.000Z'),
    );
  });

  it('keeps same-day order (installed before joined pool) for an install made today', () => {
    const at = '2026-10-11T09:00:00.000Z';
    const j = ev('pool-joined', at, { poolId: 'p1', role: 'data' });
    const i = ev('drive-installed', at, { slotLabel: 'Bay 1', installedOn: '2026-10-11' });
    const story = buildStory(newestFirst(j, i));
    expect(story.map((s) => s.kind)).toEqual(['drive-installed', 'pool-joined']);
    expect(story[0]).toMatchObject({ recorded: null, date: '2026-10-11' });
  });

  it('events without installedOn (older logs) still sort and sum by their own time', () => {
    const a = ev('drive-created', '2026-01-01T00:00:00.000Z');
    const b = ev('drive-installed', '2026-02-01T00:00:00.000Z', { slotLabel: 'Bay 1' });
    const c = ev('drive-removed', '2026-03-01T00:00:00.000Z', { slotLabel: 'Bay 1' });
    const log = newestFirst(a, b, c);
    expect(buildStory(log).map((s) => s.kind)).toEqual([
      'drive-created',
      'drive-installed',
      'drive-removed',
    ]);
    const sum = summarizeStory(log, NOW);
    expect(sum.inService).toBe(28 * DAY);
    expect(sum.onShelf).toBe(31 * DAY + (NOW - Date.parse('2026-03-01T00:00:00.000Z')));
  });
});
