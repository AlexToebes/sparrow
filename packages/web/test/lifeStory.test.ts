import { describe, expect, it } from 'vitest';
import type { DriveEvent } from '@sparrow/shared';
import { buildStory as build, summarizeStory as summarize } from '../src/lib/lifeStory';
import { bay, drive, makeEvent } from './events';

// All stories here are the story of drive d1.
const buildStory = (events: DriveEvent[]) => build(events, 'd1');
const summarizeStory = (events: DriveEvent[], now?: number) => summarize(events, 'd1', now);
const ev = makeEvent;

// The API returns newest first; these helpers take them oldest first as they were logged.
const newestFirst = (...logged: DriveEvent[]) => [...logged].reverse();

const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const DAY = 86_400_000;

describe('life story with an unrecorded installation date (R68)', () => {
  const created = ev('drive-created', '2026-10-11T08:00:00.000Z');
  const installed = ev(
    'drive-installed',
    '2026-10-11T09:00:00.000Z',
    { installedOn: null },
    { slots: [bay('s3', 'to', 'Bay 3')] },
  );
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
  const joined = ev(
    'pool-joined',
    '2026-10-11T09:00:00.000Z',
    { role: 'data', startedAt: '2023-04-05T00:00:00.000Z' },
    { pools: [{ poolId: 'p1', poolName: 'tank' }] },
  );
  const installed = ev(
    'drive-installed',
    '2026-10-11T09:00:00.000Z',
    { installedOn: '2023-04-05' },
    { slots: [bay('s3', 'to', 'Bay 3', 'Front bays')] },
  );
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
    const j = ev('pool-joined', at, { role: 'data' }, { pools: [{ poolId: 'p1', poolName: 't' }] });
    const i = ev(
      'drive-installed',
      at,
      { installedOn: '2026-10-11' },
      { slots: [bay('s1', 'to', 'Bay 1')] },
    );
    const story = buildStory(newestFirst(j, i));
    expect(story.map((s) => s.kind)).toEqual(['drive-installed', 'pool-joined']);
    expect(story[0]).toMatchObject({ recorded: null, date: '2026-10-11' });
  });

  it('events without installedOn (older logs) still sort and sum by their own time', () => {
    const a = ev('drive-created', '2026-01-01T00:00:00.000Z');
    const b = ev(
      'drive-installed',
      '2026-02-01T00:00:00.000Z',
      {},
      { slots: [bay('s1', 'to', 'Bay 1')] },
    );
    const c = ev(
      'drive-removed',
      '2026-03-01T00:00:00.000Z',
      {},
      { slots: [bay('s1', 'from', 'Bay 1')] },
    );
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
  const installed = ev(
    'drive-installed',
    '2022-02-01T10:00:00.000Z',
    { installedOn: '2022-02-01' },
    { slots: [bay('s3', 'to', 'Bay 3')] },
  );
  const INSTALLED_AT = Date.parse('2022-02-01T10:00:00.000Z'); // same day as installedOn: the exact time is kept
  const edited = ev('drive-updated', '2026-09-15T08:00:00.000Z', { changes: { notes: {} } });

  it('orders a backdated removal by removedOn and shows when it was recorded', () => {
    // Logged on 11 Oct but the drive came out on 1 Sep, before a note edited on 15 Sep.
    const removed = ev(
      'drive-removed',
      '2026-10-11T09:00:00.000Z',
      { removedOn: '2026-09-01' },
      { slots: [bay('s3', 'from', 'Bay 3')] },
    );
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
    const removed = ev(
      'drive-removed',
      '2026-10-11T09:00:00.000Z',
      { removedOn: '2026-09-01' },
      { slots: [bay('s3', 'from', 'Bay 3')] },
    );
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
    const removed = ev(
      'drive-removed',
      '2026-10-11T09:00:00.000Z',
      { removedOn: null },
      { slots: [bay('s3', 'from', 'Bay 3')] },
    );
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
    const removed = ev(
      'drive-removed',
      '2026-10-11T09:00:00.000Z',
      {},
      { slots: [bay('s3', 'from', 'Bay 3')] },
    );
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

  it('R60, R69: retiring from a bay is ONE entry, dated by the retirement date, naming the bay it left', () => {
    const retired = ev(
      'drive-retired',
      '2026-10-11T09:00:00.000Z',
      { reason: 'failed', date: '2026-08-20' },
      { slots: [bay('s3', 'from', 'Bay 3')] },
    );
    const story = buildStory(newestFirst(created, installed, retired));
    expect(story.map((s) => s.kind)).toEqual(['drive-created', 'drive-installed', 'drive-retired']);
    expect(story.at(-1)).toMatchObject({
      title: 'Retired from Bay 3',
      date: '2026-08-20',
      slot: { id: 's3', label: 'Bay 3' },
    });
    // The time in the bay counts up to the retirement date.
    expect(summarizeStory(newestFirst(created, installed, retired), NOW).inService).toBe(
      Date.parse('2026-08-20T00:00:00.000Z') - INSTALLED_AT,
    );
  });

  it('R27, R69: an RMA from a bay is ONE entry that also ends the stay and retires the drive', () => {
    const rma = ev(
      'drive-sent-for-rma',
      '2026-10-11T09:00:00.000Z',
      { date: '2026-08-20' },
      { slots: [bay('s3', 'from', 'Bay 3')] },
    );
    const log = newestFirst(created, installed, rma);
    expect(buildStory(log).at(-1)).toMatchObject({
      title: 'Sent for RMA from Bay 3',
      date: '2026-08-20',
    });
    const sum = summarizeStory(log, NOW);
    expect(sum.inService).toBe(Date.parse('2026-08-20T00:00:00.000Z') - INSTALLED_AT);
    expect(sum.onShelf).toBe(INSTALLED_AT - Date.parse('2022-01-01T08:00:00.000Z'));
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
  const installed = ev(
    'drive-installed',
    '2026-01-02T09:00:00.000Z',
    { installedOn: '2026-01-02' },
    { slots: [bay('s3', 'to', 'Bay 3', 'Front bays')] },
  );
  const moved = ev(
    'drive-moved',
    '2026-10-11T09:00:00.000Z',
    { date: '2026-10-11' },
    { slots: [bay('s3', 'from', 'Bay 3', 'Front bays'), bay('s7', 'to', 'Bay 7', 'Front bays')] },
  );

  it('R73: one drive-moved event reads as one entry, "Moved from Bay 3 to Bay 7"', () => {
    const story = buildStory(newestFirst(created, installed, moved));
    expect(story.map((s) => s.title)).toEqual([
      'Added to Sparrow',
      'Installed in Front bays, Bay 3',
      'Moved from Bay 3 to Bay 7',
    ]);
    expect(story.at(-1)!.slot).toBeNull();
  });

  it('R73, R69: the stay continues through a dated move, so in-service time is unbroken', () => {
    const sum = summarizeStory(newestFirst(created, installed, moved), NOW);
    expect(sum.inService).toBe(NOW - Date.parse('2026-01-02T09:00:00.000Z'));
    expect(sum.removalUnrecorded).toBe(false);
  });

  it('R73: a swap reads as one entry naming the other drive (with its size)', () => {
    const swapped = ev(
      'drives-swapped',
      '2026-10-11T09:00:00.000Z',
      { date: '2026-10-11' },
      {
        drives: [drive('d1', 'ZL1'), drive('d2', 'ZL123', 'subject', 4e12)],
        slots: [
          bay('s3', 'from', 'Bay 3', 'Front bays'),
          bay('s3', 'to', 'Bay 3', 'Front bays'),
          bay('s7', 'from', 'Bay 7', 'Front bays'),
          bay('s7', 'to', 'Bay 7', 'Front bays'),
        ],
      },
    );
    swapped.payload.moves = [
      { driveId: 'd1', fromSlotId: 's3', toSlotId: 's7' },
      { driveId: 'd2', fromSlotId: 's7', toSlotId: 's3' },
    ];
    expect(buildStory(newestFirst(created, installed, swapped)).at(-1)!.title).toBe(
      'Swapped with ZL123 (4 TB) — moved from Bay 3 to Bay 7',
    );
    // The other drive reads its own side of the same event.
    expect(build(newestFirst(swapped), 'd2').at(-1)!.title).toBe(
      'Swapped with ZL1 — moved from Bay 7 to Bay 3',
    );
  });

  it('R73: names the grid when the bays are in different grids; flags an unrecorded date', () => {
    const toOther = ev(
      'drive-moved',
      '2026-10-11T09:00:00.000Z',
      { date: null },
      {
        slots: [bay('s3', 'from', 'Bay 3', 'Front bays'), bay('s7', 'to', 'Left', 'Internal SSDs')],
      },
    );
    const log = newestFirst(created, installed, toOther);
    expect(buildStory(log).at(-1)!.title).toBe(
      'Moved from Front bays, Bay 3 to Internal SSDs, Left (date not recorded)',
    );
    expect(buildStory(log).at(-1)).toMatchObject({ unrecorded: true });
    const sum = summarizeStory(log, NOW);
    expect(sum).toMatchObject({ inService: 0, removalUnrecorded: true, installUnrecorded: true });
  });

  it('R73: a removal that is not part of a move stays a plain removal', () => {
    const plain = ev(
      'drive-removed',
      '2026-10-11T09:00:00.000Z',
      { removedOn: '2026-10-11' },
      { slots: [bay('s3', 'from', 'Bay 3')] },
    );
    expect(buildStory(newestFirst(created, installed, plain)).at(-1)!.title).toBe(
      'Removed from Bay 3',
    );
  });
});

describe('life story of a replacement (R37, R73, R74)', () => {
  const created = ev('drive-created', '2026-01-01T08:00:00.000Z');
  const installed = ev(
    'drive-installed',
    '2026-01-02T09:00:00.000Z',
    { installedOn: '2026-01-02' },
    { slots: [bay('s3', 'to', 'Bay 3')] },
  );
  const INSTALLED_AT = Date.parse('2026-01-02T09:00:00.000Z');
  /** d1 is replaced by ZL2SPR01 (8 TB) in Bay 3 and retired as failed. */
  const replacedOut = ev(
    'drive-replaced',
    '2026-10-11T09:00:00.000Z',
    {
      installedOn: '2026-10-01',
      outgoing: { outcome: 'retired', reason: 'failed', date: '2026-10-01' },
    },
    {
      drives: [drive('d1', 'ZL1', 'outgoing', 4e12), drive('d9', 'ZL2SPR01', 'incoming', 8e12)],
      slots: [bay('s3', 'at', 'Bay 3')],
    },
  );

  it('outgoing: "Replaced by ZL2SPR01 (8 TB) in Bay 3 — retired (failed)", on the retirement date, linking the bay', () => {
    const story = buildStory(newestFirst(created, installed, replacedOut));
    expect(story.at(-1)).toMatchObject({
      kind: 'drive-replaced',
      title: 'Replaced by ZL2SPR01 (8 TB) in Bay 3 — retired (failed)',
      date: '2026-10-01',
      slot: { id: 's3', label: 'Bay 3' },
    });
  });

  it('outgoing: the stay ends on the outgoing date and the drive is retired (no shelf time after)', () => {
    const sum = summarizeStory(newestFirst(created, installed, replacedOut), NOW);
    expect(sum.inService).toBe(Date.parse('2026-10-01T00:00:00.000Z') - INSTALLED_AT);
    expect(sum.onShelf).toBe(INSTALLED_AT - Date.parse('2026-01-01T08:00:00.000Z'));
  });

  it('outgoing to the spares: "back to spares" and shelf time resumes', () => {
    const toShelf = ev(
      'drive-replaced',
      '2026-10-11T09:00:00.000Z',
      { installedOn: '2026-10-01', outgoing: { outcome: 'spares', date: '2026-10-01' } },
      {
        drives: [drive('d1', 'ZL1', 'outgoing'), drive('d9', 'ZL2SPR01', 'incoming')],
        slots: [bay('s3', 'at', 'Bay 3')],
      },
    );
    const log = newestFirst(created, installed, toShelf);
    expect(buildStory(log).at(-1)!.title).toBe('Replaced by ZL2SPR01 in Bay 3 — back to spares');
    expect(summarizeStory(log, NOW).onShelf).toBeGreaterThan(
      INSTALLED_AT - Date.parse('2026-01-01T08:00:00.000Z'),
    );
  });

  it('outgoing with an unknown removal or retirement date says so', () => {
    const unknown = (outcome: string, date: string | null) =>
      ev(
        'drive-replaced',
        '2026-10-11T09:00:00.000Z',
        { installedOn: null, outgoing: { outcome, date, reason: 'failed' } },
        {
          drives: [drive('d1', 'ZL1', 'outgoing'), drive('d9', 'ZL2', 'incoming')],
          slots: [bay('s3', 'at', 'Bay 3')],
        },
      );
    const spares = buildStory(newestFirst(created, installed, unknown('spares', null))).at(-1)!;
    expect(spares.title).toBe(
      'Replaced by ZL2 in Bay 3 — back to spares (removal date not recorded)',
    );
    expect(spares.removalUnrecorded).toBe(true);
    const retired = buildStory(newestFirst(created, installed, unknown('rma', null))).at(-1)!;
    expect(retired.title).toBe(
      'Replaced by ZL2 in Bay 3 — sent for RMA (retirement date not recorded)',
    );
    expect(retired.retirementUnrecorded).toBe(true);
  });

  it('outgoing but moved to another bay (a spare took its place): "Replaced by ... — moved to Bay 7"', () => {
    const movedOut = ev(
      'drive-replaced',
      '2026-10-11T09:00:00.000Z',
      {
        installedOn: '2026-10-11',
        outgoing: { outcome: 'moved', date: '2026-10-11', toSlotId: 's7' },
      },
      {
        drives: [drive('d1', 'ZL1', 'outgoing'), drive('d9', 'ZL2SPR01', 'incoming', 8e12)],
        slots: [bay('s3', 'at', 'Bay 3'), bay('s7', 'to', 'Bay 7')],
      },
    );
    const log = newestFirst(created, installed, movedOut);
    expect(buildStory(log).at(-1)!.title).toBe(
      'Replaced by ZL2SPR01 (8 TB) in Bay 3 — moved to Bay 7',
    );
    // It stays installed: in-service time keeps running into the new bay.
    expect(summarizeStory(log, NOW).inService).toBe(NOW - INSTALLED_AT);
  });

  it('incoming: "Installed in Bay 3, replacing ZL2ABC03 (4 TB)", dated by the installation date', () => {
    const replacedIn = ev(
      'drive-replaced',
      '2026-10-11T09:00:00.000Z',
      {
        role: 'data',
        installedOn: '2026-10-01',
        outgoing: { outcome: 'retired', reason: 'failed', date: '2026-10-01' },
      },
      {
        drives: [drive('d9', 'ZL2ABC03', 'outgoing', 4e12), drive('d1', 'ZL1', 'incoming')],
        slots: [bay('s3', 'at', 'Bay 3', 'Front bays')],
      },
    );
    const log = newestFirst(created, replacedIn);
    const item = buildStory(log).at(-1)!;
    expect(item).toMatchObject({
      title: 'Installed in Front bays, Bay 3, replacing ZL2ABC03 (4 TB)',
      detail: 'data · ZL2ABC03 retired (failed)',
      date: '2026-10-01',
      slot: { id: 's3', label: 'Bay 3' },
    });
    expect(summarizeStory(log, NOW).inService).toBe(NOW - Date.parse('2026-10-01T00:00:00.000Z'));
  });

  it('incoming with an unknown installation date is flagged and not counted', () => {
    const replacedIn = ev(
      'drive-replaced',
      '2026-10-11T09:00:00.000Z',
      { installedOn: null, outgoing: { outcome: 'spares', date: null } },
      {
        drives: [drive('d9', 'ZL2', 'outgoing'), drive('d1', 'ZL1', 'incoming')],
        slots: [bay('s3', 'at', 'Bay 3')],
      },
    );
    const log = newestFirst(created, replacedIn);
    expect(buildStory(log).at(-1)).toMatchObject({
      title: 'Installed in Bay 3, replacing ZL2 (installation date not recorded)',
      unrecorded: true,
    });
    expect(summarizeStory(log, NOW)).toMatchObject({ inService: 0, installUnrecorded: true });
  });

  it('incoming that came from another bay (move into an occupied bay): "Moved from Bay 2 to Bay 3, replacing ..."', () => {
    const movedIn = ev(
      'drive-replaced',
      '2026-10-11T09:00:00.000Z',
      { installedOn: '2026-10-11', outgoing: { outcome: 'spares', date: '2026-10-11' } },
      {
        drives: [drive('d9', 'ZL2', 'outgoing', 4e12), drive('d1', 'ZL1', 'incoming')],
        slots: [bay('s2', 'from', 'Bay 2'), bay('s3', 'at', 'Bay 3')],
      },
    );
    const log = newestFirst(created, installed, movedIn);
    expect(buildStory(log).at(-1)!.title).toBe('Moved from Bay 2 to Bay 3, replacing ZL2 (4 TB)');
  });
});

describe('life story health entries (R20)', () => {
  const health = (at: string, from: string | null, to: string, reportedAt: string) =>
    ev('health-changed', at, { from, to, reportedAt });

  it('R20: words the first report and a change, and carries from/to for the icon', () => {
    const first = health('2026-03-05T00:00:00.000Z', null, 'ok', '2026-03-04T05:00:00.000Z');
    const change = health('2026-03-06T00:00:00.000Z', 'ok', 'warning', '2026-03-06T00:00:00.000Z');
    const items = buildStory(newestFirst(first, change));
    expect(items.map((i) => i.title)).toEqual([
      'Health first reported: OK',
      'Health: OK → Warning',
    ]);
    expect(items[1]!.health).toEqual({ from: 'ok', to: 'warning' });
  });

  it('R20: orders by reportedAt when present, not by when the poll logged it', () => {
    const created = ev('drive-created', '2026-03-01T00:00:00.000Z');
    // Logged last, but the provider reported it before the drive was added.
    const early = health('2026-03-09T00:00:00.000Z', null, 'failed', '2026-02-20T00:00:00.000Z');
    const items = buildStory(newestFirst(created, early));
    expect(items.map((i) => i.kind)).toEqual(['health-changed', 'drive-created']);
    expect(items[0]!.title).toBe('Health first reported: Failed');
  });

  it('R20: does not change the in-service or shelf totals', () => {
    const created = ev('drive-created', '2026-10-10T12:00:00.000Z');
    const h = health('2026-10-11T00:00:00.000Z', null, 'ok', '2026-10-11T00:00:00.000Z');
    expect(summarizeStory(newestFirst(created, h), NOW)).toEqual(
      summarizeStory(newestFirst(created), NOW),
    );
  });
});
