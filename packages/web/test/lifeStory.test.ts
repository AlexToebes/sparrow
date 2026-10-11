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

describe('life story with an optional removal date (R69)', () => {
  const created = ev('drive-created', '2022-01-01T08:00:00.000Z');
  const installed = ev('drive-installed', '2022-02-01T10:00:00.000Z', {
    slotLabel: 'Bay 3',
    installedOn: '2022-02-01',
  });
  const INSTALLED_AT = Date.parse('2022-02-01T10:00:00.000Z'); // same day as installedOn: the exact time is kept
  const edited = ev('drive-updated', '2026-09-15T08:00:00.000Z', { changes: { notes: {} } });

  it('orders a backdated removal by removedOn and shows when it was recorded', () => {
    // Logged on 11 Oct but the drive came out on 1 Sep, before a note edited on 15 Sep.
    const removed = ev('drive-removed', '2026-10-11T09:00:00.000Z', {
      slotLabel: 'Bay 3',
      removedOn: '2026-09-01',
    });
    const story = buildStory(newestFirst(created, installed, edited, removed));
    expect(story.map((s) => s.kind)).toEqual([
      'drive-created',
      'drive-installed',
      'drive-removed',
      'drive-updated',
    ]);
    const item = story[2]!;
    expect(item).toMatchObject({ date: '2026-09-01', removalUnrecorded: false });
    expect(item.recorded).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(item.recorded).not.toBe('2026-09-01');
    expect(item.title).toBe('Removed from Bay 3');
  });

  it('counts in-service time up to the real removal date and shelf time after it', () => {
    const removed = ev('drive-removed', '2026-10-11T09:00:00.000Z', {
      slotLabel: 'Bay 3',
      removedOn: '2026-09-01',
    });
    const sum = summarizeStory(newestFirst(created, installed, removed), NOW);
    expect(sum.inService).toBe(Date.parse('2026-09-01T00:00:00.000Z') - INSTALLED_AT);
    expect(sum.onShelf).toBe(
      INSTALLED_AT -
        Date.parse('2022-01-01T08:00:00.000Z') +
        (NOW - Date.parse('2026-09-01T00:00:00.000Z')),
    );
    expect(sum.removalUnrecorded).toBe(false);
  });

  it('marks a null removedOn as not recorded, keeps it at its logged position and does not count a recording date as real', () => {
    const removed = ev('drive-removed', '2026-10-11T09:00:00.000Z', {
      slotLabel: 'Bay 3',
      removedOn: null,
    });
    const log = newestFirst(created, installed, removed);
    const item = buildStory(log).at(-1)!;
    expect(item.title).toBe('Removed from Bay 3 (removal date not recorded)');
    expect(item).toMatchObject({ removalUnrecorded: true, unrecorded: false, recorded: null });
    const sum = summarizeStory(log, NOW);
    expect(sum.inService).toBe(0);
    expect(sum.onShelf).toBe(INSTALLED_AT - Date.parse('2022-01-01T08:00:00.000Z'));
    expect(sum.removalUnrecorded).toBe(true);
    expect(sum.installUnrecorded).toBe(false);
  });

  it('falls back to the logged time when an older event has no removedOn key', () => {
    const removed = ev('drive-removed', '2026-10-11T09:00:00.000Z', { slotLabel: 'Bay 3' });
    const log = newestFirst(created, installed, edited, removed);
    const story = buildStory(log);
    expect(story.at(-1)!).toMatchObject({
      kind: 'drive-removed',
      removalUnrecorded: false,
      recorded: null,
    });
    expect(story.at(-1)!.title).toBe('Removed from Bay 3');
    const sum = summarizeStory(log, NOW);
    expect(sum.removalUnrecorded).toBe(false);
    expect(sum.inService).toBe(Date.parse('2026-10-11T09:00:00.000Z') - INSTALLED_AT);
  });

  it('a retirement from a slot carries removedOn equal to the retirement date', () => {
    const removed = ev('drive-removed', '2026-10-11T09:00:00.000Z', {
      slotLabel: 'Bay 3',
      removedOn: '2026-08-20',
    });
    const retired = ev('drive-retired', '2026-10-11T09:00:00.000Z', {
      reason: 'failed',
      date: '2026-08-20',
    });
    const story = buildStory(newestFirst(created, installed, removed, retired));
    expect(story.map((s) => s.kind).slice(-2)).toEqual(['drive-removed', 'drive-retired']);
    expect(story.at(-2)!.date).toBe('2026-08-20');
  });
});

describe('life story with an optional retirement date (R60)', () => {
  const created = ev('drive-created', '2026-01-01T08:00:00.000Z');

  it('uses the retirement date when present, orders by it and shows when it was recorded', () => {
    const retired = ev('drive-retired', '2026-10-11T09:00:00.000Z', {
      reason: 'failed',
      date: '2026-09-01',
    });
    const story = buildStory(newestFirst(created, retired));
    expect(story.at(-1)).toMatchObject({
      kind: 'drive-retired',
      title: 'Retired',
      date: '2026-09-01',
      recorded: '2026-10-11',
      retirementUnrecorded: false,
    });
  });

  it('marks a null date as not recorded, keeps the logged position, and does not count the recording day as real', () => {
    const retired = ev('drive-retired', '2026-10-11T09:00:00.000Z', {
      reason: 'failed',
      date: null,
    });
    const story = buildStory(newestFirst(created, retired));
    expect(story.at(-1)).toMatchObject({
      title: 'Retired (retirement date not recorded)',
      date: '2026-10-11',
      recorded: null,
      retirementUnrecorded: true,
    });
    const sum = summarizeStory(newestFirst(created, retired), NOW);
    expect(sum.retirementUnrecorded).toBe(true);
    expect(sum.onShelf).toBe(0);
  });

  it('counts shelf time up to a real retirement date', () => {
    const retired = ev('drive-retired', '2026-10-11T09:00:00.000Z', {
      reason: 'other',
      date: '2026-01-11',
    });
    const sum = summarizeStory(newestFirst(created, retired), NOW);
    expect(sum.onShelf).toBe(
      Date.parse('2026-01-11T00:00:00.000Z') - Date.parse('2026-01-01T08:00:00.000Z'),
    );
    expect(sum.retirementUnrecorded).toBe(false);
  });

  it('an RMA without a date is labelled too', () => {
    const rma = ev('drive-sent-for-rma', '2026-10-11T09:00:00.000Z', { date: null });
    const story = buildStory(newestFirst(created, rma));
    expect(story.at(-1)).toMatchObject({
      title: 'Sent for RMA (date not recorded)',
      retirementUnrecorded: true,
    });
  });
});

describe('life story of a move between bays (R73)', () => {
  const created = ev('drive-created', '2026-01-01T08:00:00.000Z');
  const installed = ev('drive-installed', '2026-01-02T09:00:00.000Z', {
    slotId: 's3',
    slotLabel: 'Bay 3',
    gridName: 'Front bays',
    installedOn: '2026-01-02',
  });
  const removed = ev('drive-removed', '2026-10-11T09:00:00.000Z', {
    slotId: 's3',
    slotLabel: 'Bay 3',
    gridName: 'Front bays',
    installedOn: '2026-01-02',
    removedOn: '2026-10-11',
    movedToSlotId: 's7',
  });
  const arrived = ev('drive-installed', '2026-10-11T09:00:00.000Z', {
    slotId: 's7',
    slotLabel: 'Bay 7',
    gridName: 'Front bays',
    installedOn: '2026-10-11',
    movedFromSlotId: 's3',
  });

  it('R73: reads the removed + installed pair as one entry', () => {
    const story = buildStory(newestFirst(created, installed, removed, arrived));
    expect(story.map((s) => s.title)).toEqual([
      'Added to Sparrow',
      'Installed in Front bays, Bay 3',
      'Moved from Bay 3 to Bay 7',
    ]);
  });

  it('R73: a swap reads as one entry naming the other drive', () => {
    const swapped = { swappedWithDriveId: 'x', swappedWithSerial: 'ZL123' };
    const story = buildStory(
      newestFirst(
        created,
        installed,
        { ...removed, payload: { ...removed.payload, ...swapped } },
        { ...arrived, payload: { ...arrived.payload, ...swapped } },
      ),
    );
    expect(story.at(-1)!.title).toBe('Swapped from Bay 3 to Bay 7 (with ZL123)');
  });

  it('R73: names the grid when the bays are in different grids; flags an unrecorded date', () => {
    const toOther = ev('drive-installed', '2026-10-11T09:00:00.000Z', {
      slotId: 's7',
      slotLabel: 'Left',
      gridName: 'Internal SSDs',
      installedOn: null,
      movedFromSlotId: 's3',
    });
    const story = buildStory(newestFirst(created, installed, removed, toOther));
    expect(story.at(-1)!.title).toBe(
      'Moved from Front bays, Bay 3 to Internal SSDs, Left (date not recorded)',
    );
  });

  it('R73: a removal that is not part of a move stays a plain removal', () => {
    const plain = ev('drive-removed', '2026-10-11T09:00:00.000Z', {
      slotId: 's3',
      slotLabel: 'Bay 3',
      removedOn: '2026-10-11',
    });
    expect(buildStory(newestFirst(created, installed, plain)).at(-1)!.title).toBe(
      'Removed from Bay 3',
    );
  });
});
