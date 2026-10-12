import { describe, expect, it } from 'vitest';
import type { Activity } from '@sparrow/shared';
import { buildStory as build, summarizeStory as summarize } from '../src/lib/lifeStory';
import { act, ev } from './activities';

// All stories here are the story of drive d1.
const buildStory = (activities: Activity[]) => build(activities, 'd1');
const summarizeStory = (activities: Activity[], now?: number) => summarize(activities, 'd1', now);

// The API returns newest first; these helpers take them oldest first as they were logged.
const newestFirst = (...logged: Activity[]) => [...logged].reverse();

const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const DAY = 86_400_000;

const d1 = (name = 'ZL1', cap: number | null = null): [string, string, number | null] => [
  'd1',
  name,
  cap,
];
const bay = (id: string, label: string, grid?: string): [string, string, string?] => [
  id,
  label,
  grid,
];

/** R14: the drive was added to Sparrow. */
const added = (at: string) => act('drive-added', at, null, [ev('drive-created', { drive: d1() })]);
/** R68: assigned into a bay on `on` (null = not recorded). */
const assigned = (at: string, on: string | null, slot = bay('s3', 'Bay 3'), poolRole = null) =>
  act('assigned', at, on, [ev('drive-installed', { drive: d1(), slot, payload: { poolRole } })]);
/** R69: back to the spares on `on`. */
const removed = (at: string, on: string | null, slot = bay('s3', 'Bay 3')) =>
  act('removed', at, on, [
    ev('drive-uninstalled', { drive: d1(), slot, payload: { installedOn: null, poolRole: null } }),
  ]);

describe('life story with an unrecorded installation date (R68)', () => {
  const created = added('2026-10-11T08:00:00.000Z');
  const installed = assigned('2026-10-11T09:00:00.000Z', null);
  const log = newestFirst(created, installed);

  it('titles the install as not recorded and shows the logged day as its date', () => {
    const item = buildStory(log).find((s) => s.kind === 'assigned')!;
    expect(item.title).toBe('Installed in Bay 3 (installation date not recorded)');
    expect(item).toMatchObject({ unrecorded: true, recorded: null });
    expect(item.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('does not count in-service time from the recording date; flags it instead', () => {
    const sum = summarizeStory(log, NOW);
    expect(sum.inService).toBe(0);
    expect(sum.installUnrecorded).toBe(true);
    expect(sum.onShelf).toBe(60 * 60 * 1000);
  });

  it('counts in service again once a date is set by an edit, and labels the edit', () => {
    const edit = act('drive-edited', '2026-10-11T10:00:00.000Z', null, [
      ev('installation-updated', {
        drive: d1(),
        slot: bay('s3', 'Bay 3'),
        payload: { changes: { installedOn: { from: null, to: '2020-01-01' } } },
      }),
    ]);
    const withEdit = newestFirst(created, installed, edit);
    expect(buildStory(withEdit).at(-1)!.title).toBe(
      'Installation date changed from not recorded to 2020-01-01',
    );
    const sum = summarizeStory(withEdit, NOW);
    expect(sum.installUnrecorded).toBe(false);
    expect(sum.inService).toBe(NOW - Date.parse('2020-01-01T00:00:00.000Z'));
  });
});

describe('life story with a backdated installation (R68)', () => {
  const created = added('2026-10-11T08:00:00.000Z');
  // ONE activity: installed in Bay 3 of the Front bays as part of the pool tank, on a past day.
  const installed = act('assigned', '2026-10-11T09:00:00.000Z', '2023-04-05', [
    ev('drive-installed', {
      drive: d1(),
      slot: bay('s3', 'Bay 3', 'Front bays'),
      pool: ['p1', 'tank'],
      payload: { poolRole: 'data' },
    }),
  ]);
  const log = newestFirst(created, installed);

  it('is one entry for the install with its pool, dated by the activity (no pool tie-breaker needed)', () => {
    const story = buildStory(log);
    expect(story.map((s) => s.kind)).toEqual(['assigned', 'drive-added']);
    expect(story[0]).toMatchObject({
      title: 'Installed in Front bays, Bay 3 · tank (data)',
      date: '2023-04-05',
      recorded: expect.any(String),
      slot: { id: 's3', label: 'Bay 3' },
    });
    expect(story[1]!.recorded).toBeNull();
  });

  it('shows the recorded day only on backdated entries', () => {
    const story = buildStory(log);
    expect(story[0]!.recorded).toMatch(/^2026-10-1[01]$/);
    expect(story[1]!.recorded).toBeNull();
  });

  it('counts time in service from the installation date, not from when it was logged', () => {
    const sum = summarizeStory(log, NOW);
    expect(sum.inService).toBe(NOW - Date.parse('2023-04-05T00:00:00.000Z'));
    expect(sum.installUnrecorded).toBe(false);
    expect(sum.inService).toBeGreaterThan(1000 * DAY);
    expect(sum.onShelf).toBe(0);
  });

  it('labels an edit of the installation date and moves the in-service start', () => {
    const edit = act('drive-edited', '2026-10-11T10:00:00.000Z', null, [
      ev('drive-updated', { drive: d1(), payload: { changes: { model: { from: 'a', to: 'b' } } } }),
      ev('installation-updated', {
        drive: d1(),
        slot: bay('s3', 'Bay 3'),
        payload: { changes: { installedOn: { from: '2023-04-05', to: '2020-01-01' } } },
      }),
    ]);
    const withEdit = newestFirst(created, installed, edit);
    const last = buildStory(withEdit).at(-1)!;
    expect(last.title).toBe('Installation date changed from 2023-04-05 to 2020-01-01');
    expect(last.detail).toBe('Also edited: model');
    expect(summarizeStory(withEdit, NOW).inService).toBe(
      NOW - Date.parse('2020-01-01T00:00:00.000Z'),
    );
  });

  it('orders the same effective instant by the log position (seq)', () => {
    const at = '2026-10-11T09:00:00.000Z';
    const first = act(
      'drive-edited',
      at,
      null,
      [ev('drive-updated', { drive: d1(), payload: { changes: { notes: {} } } })],
      { seq: 100 },
    );
    const second = act(
      'assigned',
      at,
      '2026-10-11',
      [ev('drive-installed', { drive: d1(), slot: bay('s1', 'Bay 1') })],
      { seq: 101 },
    );
    const story = buildStory([second, first]);
    expect(story.map((s) => s.kind)).toEqual(['drive-edited', 'assigned']);
    expect(story[1]).toMatchObject({ recorded: null, date: '2026-10-11' });
  });

  it('activities without a user date sort and sum by the time they were recorded', () => {
    const a = added('2026-01-01T00:00:00.000Z');
    const b = act('assigned', '2026-02-01T00:00:00.000Z', null, [
      ev('drive-installed', { drive: d1(), slot: bay('s1', 'Bay 1') }),
    ]);
    const c = act('removed', '2026-03-01T00:00:00.000Z', '2026-03-01', [
      ev('drive-uninstalled', {
        drive: d1(),
        slot: bay('s1', 'Bay 1'),
        payload: { installedOn: null },
      }),
    ]);
    // An unrecorded install date: the stay is not counted; the shelf time before it is.
    const sum = summarizeStory(newestFirst(a, b, c), NOW);
    expect(sum.installUnrecorded).toBe(true);
    expect(sum.inService).toBe(0);
    // The shelf time before the install counts, and so does the time on the shelf after the dated removal.
    expect(sum.onShelf).toBe(31 * DAY + (NOW - Date.parse('2026-03-01T00:00:00.000Z')));
  });
});

describe('life story with an optional removal date (R69)', () => {
  const created = added('2022-01-01T08:00:00.000Z');
  const installed = assigned('2022-02-01T10:00:00.000Z', '2022-02-01'); // same day: the exact time is kept
  const INSTALLED_AT = Date.parse('2022-02-01T10:00:00.000Z');
  const edited = act('drive-edited', '2026-09-15T08:00:00.000Z', null, [
    ev('drive-updated', { drive: d1(), payload: { changes: { notes: {} } } }),
  ]);

  it('orders a backdated removal by its day and shows when it was recorded', () => {
    // Logged on 11 Oct but the drive came out on 1 Sep, before a note edited on 15 Sep.
    const out = removed('2026-10-11T09:00:00.000Z', '2026-09-01');
    const story = buildStory(newestFirst(created, installed, edited, out));
    expect(story.map((s) => s.kind)).toEqual([
      'drive-added',
      'assigned',
      'removed',
      'drive-edited',
    ]);
    const item = story[2]!;
    expect(item).toMatchObject({ date: '2026-09-01', removalUnrecorded: false });
    expect(item.recorded).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(item.recorded).not.toBe('2026-09-01');
    expect(item.title).toBe('Removed from Bay 3 · back to spares');
  });

  it('counts in-service time up to the real removal date and shelf time after it', () => {
    const out = removed('2026-10-11T09:00:00.000Z', '2026-09-01');
    const sum = summarizeStory(newestFirst(created, installed, out), NOW);
    expect(sum.inService).toBe(Date.parse('2026-09-01T00:00:00.000Z') - INSTALLED_AT);
    expect(sum.onShelf).toBe(
      INSTALLED_AT -
        Date.parse('2022-01-01T08:00:00.000Z') +
        (NOW - Date.parse('2026-09-01T00:00:00.000Z')),
    );
    expect(sum.removalUnrecorded).toBe(false);
  });

  it('marks a null date as not recorded, keeps it at its logged position and does not count a recording date as real', () => {
    const out = removed('2026-10-11T09:00:00.000Z', null);
    const log = newestFirst(created, installed, out);
    const item = buildStory(log).at(-1)!;
    expect(item.title).toBe('Removed from Bay 3 (removal date not recorded) · back to spares');
    expect(item).toMatchObject({ removalUnrecorded: true, unrecorded: false, recorded: null });
    const sum = summarizeStory(log, NOW);
    expect(sum.inService).toBe(0);
    expect(sum.onShelf).toBe(INSTALLED_AT - Date.parse('2022-01-01T08:00:00.000Z'));
    expect(sum.removalUnrecorded).toBe(true);
    expect(sum.installUnrecorded).toBe(false);
  });

  it('R60, R69: retiring from a bay is ONE entry, dated by the retirement day, naming the bay and the pool it left', () => {
    const retired = act('retired', '2026-10-11T09:00:00.000Z', '2026-08-20', [
      ev('drive-uninstalled', {
        drive: d1(),
        slot: bay('s3', 'Bay 3'),
        pool: ['p1', 'tank'],
        payload: { installedOn: '2022-02-01', poolRole: 'data' },
      }),
      ev('drive-retired', { drive: d1(), payload: { reason: 'failed', note: 'clicking' } }),
    ]);
    const log = newestFirst(created, installed, retired);
    const story = buildStory(log);
    expect(story.map((s) => s.kind)).toEqual(['drive-added', 'assigned', 'retired']);
    expect(story.at(-1)).toMatchObject({
      title: 'Retired from Bay 3 · left tank',
      detail: 'failed · clicking',
      date: '2026-08-20',
      slot: { id: 's3', label: 'Bay 3' },
    });
    // The time in the bay counts up to the retirement date.
    expect(summarizeStory(log, NOW).inService).toBe(
      Date.parse('2026-08-20T00:00:00.000Z') - INSTALLED_AT,
    );
  });

  it('R27, R69: an RMA from a bay is ONE entry that also ends the stay and retires the drive', () => {
    const rma = act('sent-for-rma', '2026-10-11T09:00:00.000Z', '2026-08-20', [
      ev('drive-uninstalled', {
        drive: d1(),
        slot: bay('s3', 'Bay 3'),
        payload: { installedOn: '2022-02-01', poolRole: null },
      }),
      ev('drive-sent-for-rma', { drive: d1(), payload: { note: null } }),
    ]);
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
  const created = added('2026-01-01T08:00:00.000Z');
  const retire = (on: string | null, kind: 'retired' | 'sent-for-rma' = 'retired') =>
    act(kind, '2026-10-11T09:00:00.000Z', on, [
      kind === 'retired'
        ? ev('drive-retired', { drive: d1(), payload: { reason: 'failed', note: null } })
        : ev('drive-sent-for-rma', { drive: d1(), payload: { note: null } }),
    ]);

  it('uses the retirement date when present, orders by it and shows when it was recorded', () => {
    const story = buildStory(newestFirst(created, retire('2026-09-01')));
    expect(story.at(-1)).toMatchObject({
      kind: 'retired',
      title: 'Retired',
      detail: 'failed',
      date: '2026-09-01',
      recorded: '2026-10-11',
      retirementUnrecorded: false,
    });
  });

  it('marks a null date as not recorded, keeps the logged position, and does not count the recording day as real', () => {
    const log = newestFirst(created, retire(null));
    expect(buildStory(log).at(-1)).toMatchObject({
      title: 'Retired (retirement date not recorded)',
      date: '2026-10-11',
      recorded: null,
      retirementUnrecorded: true,
    });
    const sum = summarizeStory(log, NOW);
    expect(sum.retirementUnrecorded).toBe(true);
    expect(sum.onShelf).toBe(0);
  });

  it('counts shelf time up to a real retirement date', () => {
    const sum = summarizeStory(newestFirst(created, retire('2026-01-11')), NOW);
    expect(sum.onShelf).toBe(
      Date.parse('2026-01-11T00:00:00.000Z') - Date.parse('2026-01-01T08:00:00.000Z'),
    );
    expect(sum.retirementUnrecorded).toBe(false);
  });

  it('an RMA without a date is labelled too', () => {
    const story = buildStory(newestFirst(created, retire(null, 'sent-for-rma')));
    expect(story.at(-1)).toMatchObject({
      title: 'Sent for RMA (retirement date not recorded)',
      retirementUnrecorded: true,
    });
  });

  it('R63: an imported retired drive is one entry with its reason and date', () => {
    const imported = act('retired-imported', '2026-10-11T09:00:00.000Z', '2025-12-01', [
      ev('drive-created', { drive: d1() }),
      ev('drive-retired', { drive: d1(), payload: { reason: 'replaced', note: 'old' } }),
    ]);
    const story = buildStory([imported]);
    expect(story).toHaveLength(1);
    expect(story[0]).toMatchObject({
      title: 'Imported as a retired drive (replaced)',
      detail: 'old',
      date: '2025-12-01',
    });
  });

  it('R61: reinstating is one entry and puts the drive back on the shelf', () => {
    const back = act(
      'reinstated',
      '2026-10-01T00:00:00.000Z',
      null,
      [ev('drive-reinstated', { drive: d1(), payload: { previousReason: 'failed' } })],
      { note: 'false alarm' },
    );
    const log = newestFirst(created, retire('2026-02-01'), back);
    const story = buildStory(log);
    expect(story.at(-1)).toMatchObject({ title: 'Reinstated as a spare', detail: 'false alarm' });
    // Shelf time before the retirement, then retired (not shelf time), then the shelf again.
    expect(summarizeStory(log, NOW).onShelf).toBe(
      Date.parse('2026-02-01T00:00:00.000Z') -
        Date.parse('2026-01-01T08:00:00.000Z') +
        (NOW - Date.parse('2026-10-01T00:00:00.000Z')),
    );
  });
});

describe('life story of a move between bays (R73)', () => {
  const created = added('2026-01-01T08:00:00.000Z');
  const installed = assigned(
    '2026-01-02T09:00:00.000Z',
    '2026-01-02',
    bay('s3', 'Bay 3', 'Front bays'),
  );
  const moved = act('moved', '2026-10-11T09:00:00.000Z', '2026-10-11', [
    ev('drive-uninstalled', {
      drive: d1(),
      slot: bay('s3', 'Bay 3', 'Front bays'),
      payload: { installedOn: '2026-01-02' },
    }),
    ev('drive-installed', {
      drive: d1(),
      slot: bay('s7', 'Bay 7', 'Front bays'),
      payload: { poolRole: null },
    }),
  ]);

  it('R73: one moved activity reads as one entry, "Moved Bay 3 → Bay 7"', () => {
    const story = buildStory(newestFirst(created, installed, moved));
    expect(story.map((s) => s.title)).toEqual([
      'Added to Sparrow',
      'Installed in Front bays, Bay 3',
      'Moved Bay 3 → Bay 7',
    ]);
    expect(story.at(-1)!.slot).toMatchObject({ id: 's7' });
  });

  it('R73, R69: the stay continues through a dated move, so in-service time is unbroken', () => {
    const sum = summarizeStory(newestFirst(created, installed, moved), NOW);
    expect(sum.inService).toBe(NOW - Date.parse('2026-01-02T09:00:00.000Z'));
    expect(sum.removalUnrecorded).toBe(false);
  });

  it('R73: a swap reads as one entry naming the other drive (with its size), from each side', () => {
    const swapped = act('swapped', '2026-10-11T09:00:00.000Z', '2026-10-11', [
      ev('drive-uninstalled', { drive: d1(), slot: bay('s3', 'Bay 3', 'Front bays') }),
      ev('drive-uninstalled', {
        drive: ['d2', 'ZL123', 4e12],
        slot: bay('s7', 'Bay 7', 'Front bays'),
      }),
      ev('drive-installed', { drive: d1(), slot: bay('s7', 'Bay 7', 'Front bays') }),
      ev('drive-installed', {
        drive: ['d2', 'ZL123', 4e12],
        slot: bay('s3', 'Bay 3', 'Front bays'),
      }),
    ]);
    expect(buildStory(newestFirst(created, installed, swapped)).at(-1)!.title).toBe(
      'Swapped with ZL123 (4 TB) — Bay 3 → Bay 7',
    );
    // The other drive reads its own side of the same activity.
    expect(build([swapped], 'd2').at(-1)!.title).toBe('Swapped with ZL1 — Bay 7 → Bay 3');
  });

  it('R73: names the grid when the bays are in different grids; flags an unrecorded date', () => {
    const toOther = act('moved', '2026-10-11T09:00:00.000Z', null, [
      ev('drive-uninstalled', { drive: d1(), slot: bay('s3', 'Bay 3', 'Front bays') }),
      ev('drive-installed', { drive: d1(), slot: bay('s7', 'Left', 'Internal SSDs') }),
    ]);
    const log = newestFirst(created, installed, toOther);
    expect(buildStory(log).at(-1)!.title).toBe(
      'Moved Front bays, Bay 3 → Internal SSDs, Left (date not recorded)',
    );
    expect(buildStory(log).at(-1)).toMatchObject({ unrecorded: true });
    const sum = summarizeStory(log, NOW);
    expect(sum).toMatchObject({ inService: 0, removalUnrecorded: true, installUnrecorded: true });
  });

  it('R73: moving into an occupied bay says which drive was replaced and what became of it', () => {
    const intoOccupied = act('moved', '2026-10-11T09:00:00.000Z', '2026-10-11', [
      ev('drive-uninstalled', { drive: ['d9', 'ZL2', 4e12], slot: bay('s7', 'Bay 7') }),
      ev('drive-retired', { drive: ['d9', 'ZL2', 4e12], payload: { reason: 'failed' } }),
      ev('drive-uninstalled', { drive: d1(), slot: bay('s3', 'Bay 3') }),
      ev('drive-installed', { drive: d1(), slot: bay('s7', 'Bay 7') }),
      ev('drive-installed', { drive: ['d8', 'ZL2SPR01', 8e12], slot: bay('s3', 'Bay 3') }),
    ]);
    const item = buildStory(newestFirst(created, installed, intoOccupied)).at(-1)!;
    expect(item.title).toBe('Moved Bay 3 → Bay 7 · replaced ZL2 (4 TB) · it was retired (failed)');
    expect(item.detail).toBe('ZL2SPR01 (8 TB) took Bay 3');
  });
});

describe('life story of a replacement (R37, R73, R74)', () => {
  const created = added('2026-01-01T08:00:00.000Z');
  const installed = assigned('2026-01-02T09:00:00.000Z', '2026-01-02');
  const INSTALLED_AT = Date.parse('2026-01-02T09:00:00.000Z');
  const outgoingEvents = (outcome: 'retired' | 'rma' | 'spares') => [
    ev('drive-uninstalled', {
      drive: d1('ZL1', 4e12),
      slot: bay('s3', 'Bay 3'),
      pool: ['p1', 'tank'],
      payload: { installedOn: '2026-01-02', poolRole: 'data' },
    }),
    ...(outcome === 'retired'
      ? [ev('drive-retired', { drive: d1('ZL1', 4e12), payload: { reason: 'failed', note: null } })]
      : outcome === 'rma'
        ? [ev('drive-sent-for-rma', { drive: d1('ZL1', 4e12), payload: { note: null } })]
        : []),
    ev('drive-installed', {
      drive: ['d9', 'ZL2SPR01', 8e12],
      slot: bay('s3', 'Bay 3'),
      pool: ['p1', 'tank'],
      payload: { poolRole: 'data' },
    }),
  ];

  it('outgoing: "Replaced by ZL2SPR01 (8 TB) in Bay 3 · retired (failed) · left tank", on the retirement day, linking the bay', () => {
    const replaced = act(
      'replaced',
      '2026-10-11T09:00:00.000Z',
      '2026-10-01',
      outgoingEvents('retired'),
    );
    const story = buildStory(newestFirst(created, installed, replaced));
    expect(story.at(-1)).toMatchObject({
      kind: 'replaced',
      title: 'Replaced by ZL2SPR01 (8 TB) in Bay 3 · retired (failed) · left tank',
      date: '2026-10-01',
      slot: { id: 's3', label: 'Bay 3' },
    });
  });

  it('outgoing: the stay ends on that day and the drive is retired (no shelf time after)', () => {
    const replaced = act(
      'replaced',
      '2026-10-11T09:00:00.000Z',
      '2026-10-01',
      outgoingEvents('retired'),
    );
    const sum = summarizeStory(newestFirst(created, installed, replaced), NOW);
    expect(sum.inService).toBe(Date.parse('2026-10-01T00:00:00.000Z') - INSTALLED_AT);
    expect(sum.onShelf).toBe(INSTALLED_AT - Date.parse('2026-01-01T08:00:00.000Z'));
  });

  it('outgoing to the spares: "back to spares" and shelf time resumes', () => {
    const replaced = act(
      'replaced',
      '2026-10-11T09:00:00.000Z',
      '2026-10-01',
      outgoingEvents('spares'),
    );
    const log = newestFirst(created, installed, replaced);
    expect(buildStory(log).at(-1)!.title).toBe(
      'Replaced by ZL2SPR01 (8 TB) in Bay 3 · back to spares · left tank',
    );
    expect(summarizeStory(log, NOW).onShelf).toBeGreaterThan(
      INSTALLED_AT - Date.parse('2026-01-01T08:00:00.000Z'),
    );
  });

  it('outgoing with an unknown removal or retirement date says so', () => {
    const spares = buildStory(
      newestFirst(
        created,
        installed,
        act('replaced', '2026-10-11T09:00:00.000Z', null, outgoingEvents('spares')),
      ),
    ).at(-1)!;
    expect(spares.title).toBe(
      'Replaced by ZL2SPR01 (8 TB) in Bay 3 (removal date not recorded) · back to spares · left tank',
    );
    expect(spares.removalUnrecorded).toBe(true);
    const rma = buildStory(
      newestFirst(
        created,
        installed,
        act('replaced', '2026-10-11T09:00:00.000Z', null, outgoingEvents('rma')),
      ),
    ).at(-1)!;
    expect(rma.title).toBe(
      'Replaced by ZL2SPR01 (8 TB) in Bay 3 (retirement date not recorded) · sent for RMA · left tank',
    );
    expect(rma.retirementUnrecorded).toBe(true);
  });

  it('outgoing but moved to another bay (a spare took its place): "Moved Bay 3 → Bay 7" and who took the bay', () => {
    const moved = act('moved', '2026-10-11T09:00:00.000Z', '2026-10-11', [
      ev('drive-uninstalled', { drive: d1(), slot: bay('s3', 'Bay 3') }),
      ev('drive-installed', { drive: d1(), slot: bay('s7', 'Bay 7') }),
      ev('drive-installed', { drive: ['d9', 'ZL2SPR01', 8e12], slot: bay('s3', 'Bay 3') }),
    ]);
    const log = newestFirst(created, installed, moved);
    const item = buildStory(log).at(-1)!;
    expect(item.title).toBe('Moved Bay 3 → Bay 7');
    expect(item.detail).toBe('ZL2SPR01 (8 TB) took Bay 3');
    // It stays installed: in-service time keeps running into the new bay.
    expect(summarizeStory(log, NOW).inService).toBe(NOW - INSTALLED_AT);
  });

  it('incoming: "Replaced ZL2ABC03 (4 TB) in Bay 3 · it was retired (failed)", dated by the installation day', () => {
    const replacedIn = act('replaced', '2026-10-11T09:00:00.000Z', '2026-10-01', [
      ev('drive-uninstalled', {
        drive: ['d9', 'ZL2ABC03', 4e12],
        slot: bay('s3', 'Bay 3', 'Front bays'),
      }),
      ev('drive-retired', { drive: ['d9', 'ZL2ABC03', 4e12], payload: { reason: 'failed' } }),
      ev('drive-installed', {
        drive: d1(),
        slot: bay('s3', 'Bay 3', 'Front bays'),
        pool: ['p1', 'tank'],
        payload: { poolRole: 'data' },
      }),
    ]);
    const log = newestFirst(created, replacedIn);
    const item = buildStory(log).at(-1)!;
    expect(item).toMatchObject({
      title:
        'Replaced ZL2ABC03 (4 TB) in Front bays, Bay 3 · it was retired (failed) · tank (data)',
      date: '2026-10-01',
      slot: { id: 's3', label: 'Bay 3' },
    });
    expect(summarizeStory(log, NOW).inService).toBe(NOW - Date.parse('2026-10-01T00:00:00.000Z'));
  });

  it('incoming with an unknown installation date is flagged and not counted', () => {
    const replacedIn = act('replaced', '2026-10-11T09:00:00.000Z', null, [
      ev('drive-uninstalled', { drive: ['d9', 'ZL2', null], slot: bay('s3', 'Bay 3') }),
      ev('drive-installed', { drive: d1(), slot: bay('s3', 'Bay 3') }),
    ]);
    const log = newestFirst(created, replacedIn);
    expect(buildStory(log).at(-1)).toMatchObject({
      title: 'Replaced ZL2 in Bay 3 (installation date not recorded) · it went back to spares',
      unrecorded: true,
    });
    expect(summarizeStory(log, NOW)).toMatchObject({ inService: 0, installUnrecorded: true });
  });
});

describe('life story of discovered drives, suggestions and pool changes', () => {
  it('R23: a drive created from a discovered one is one entry with its placement', () => {
    const found = act('discovered-created', '2026-10-11T09:00:00.000Z', null, [
      ev('drive-created', { drive: d1() }),
      ev('drive-installed', {
        drive: d1(),
        slot: bay('s3', 'Bay 3', 'Front bays'),
        pool: ['p1', 'tank'],
        payload: { poolRole: 'data' },
      }),
    ]);
    const story = buildStory([found]);
    expect(story).toHaveLength(1);
    expect(story[0]!.title).toBe(
      'Found in the NAS and added · installed in Front bays, Bay 3 (installation date not recorded) · tank (data)',
    );
  });

  it('R22: linking is one entry naming the observation', () => {
    const linked = act('discovered-linked', '2026-10-11T09:00:00.000Z', '2025-01-01', [
      ev('drive-linked', { drive: d1(), payload: { observationSerial: 'ZL1-OBS', filled: {} } }),
      ev('drive-installed', { drive: d1(), slot: bay('s3', 'Bay 3') }),
    ]);
    expect(buildStory([linked])[0]).toMatchObject({
      title: 'Linked to a drive in the NAS · installed in Bay 3',
      detail: 'ZL1-OBS',
      date: '2025-01-01',
    });
  });

  it('R72: applied, dismissed and restored suggestions use our labels, one entry per activity', () => {
    const applied = act('suggestions-applied', '2026-10-11T09:00:00.000Z', null, [
      ev('drive-updated', {
        drive: d1(),
        payload: { source: 'provider', changes: { model: {}, capacityBytes: {} } },
      }),
    ]);
    const dismissed = act('suggestions-dismissed', '2026-10-11T10:00:00.000Z', null, [
      ev('suggestion-dismissed', { drive: d1(), payload: { field: 'model', value: 'WDC' } }),
    ]);
    const dismissedTwo = act('suggestions-dismissed', '2026-10-11T10:30:00.000Z', null, [
      ev('suggestion-dismissed', { drive: d1(), payload: { field: 'model', value: 'WDC' } }),
      ev('suggestion-dismissed', { drive: d1(), payload: { field: 'driveType', value: 'SSD' } }),
    ]);
    const restored = act('suggestions-restored', '2026-10-11T11:00:00.000Z', null, [
      ev('suggestion-dismissed', { drive: d1(), payload: { field: 'model', value: null } }),
    ]);
    const titles = buildStory(newestFirst(applied, dismissed, dismissedTwo, restored)).map(
      (s) => s.title,
    );
    expect(titles).toEqual([
      'Details updated from the provider: model, capacity',
      "Dismissed suggested model 'WDC'",
      "Dismissed suggestions: model 'WDC', type 'SSD'",
      'Restored suggestion for model',
    ]);
  });

  it('R29, R33: pool join, role change, pool change and leave are one entry each', () => {
    const slot = bay('s3', 'Bay 3');
    const join = act('pool-joined', '2026-10-01T00:00:00.000Z', null, [
      ev('pool-joined', { drive: d1(), slot, pool: ['p1', 'tank'], payload: { poolRole: 'data' } }),
    ]);
    const role = act('pool-role-changed', '2026-10-02T00:00:00.000Z', null, [
      ev('pool-role-changed', {
        drive: d1(),
        slot,
        pool: ['p1', 'tank'],
        payload: { from: 'data', to: 'hot-spare' },
      }),
    ]);
    const change = act('pool-changed', '2026-10-03T00:00:00.000Z', null, [
      ev('pool-left', {
        drive: d1(),
        slot,
        pool: ['p1', 'tank'],
        payload: { poolRole: 'hot-spare' },
      }),
      ev('pool-joined', {
        drive: d1(),
        slot,
        pool: ['p2', 'scratch'],
        payload: { poolRole: 'data' },
      }),
    ]);
    const leave = act('pool-left', '2026-10-04T00:00:00.000Z', null, [
      ev('pool-left', {
        drive: d1(),
        slot,
        pool: ['p2', 'scratch'],
        payload: { poolRole: 'data' },
      }),
    ]);
    const story = buildStory(newestFirst(join, role, change, leave));
    expect(story.map((s) => [s.title, s.detail])).toEqual([
      ['Joined pool tank', 'data'],
      ['Pool role changed', 'data → hot spare'],
      ['Changed pool from tank to scratch', 'data'],
      ['Left pool scratch', 'data'],
    ]);
  });
});

describe('life story health entries (R20)', () => {
  const health = (at: string, from: string | null, to: string, reportedAt: string) =>
    act('health-polled', at, null, [
      ev('health-changed', { drive: d1(), payload: { from, to, reportedAt } }),
    ]);

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
    const created = added('2026-03-01T00:00:00.000Z');
    // Logged last, but the provider reported it before the drive was added.
    const early = health('2026-03-09T00:00:00.000Z', null, 'failed', '2026-02-20T00:00:00.000Z');
    const items = buildStory(newestFirst(created, early));
    expect(items.map((i) => i.kind)).toEqual(['health-polled', 'drive-added']);
    expect(items[0]!.title).toBe('Health first reported: Failed');
  });

  it('R20: does not change the in-service or shelf totals', () => {
    const created = added('2026-10-10T12:00:00.000Z');
    const h = health('2026-10-11T00:00:00.000Z', null, 'ok', '2026-10-11T00:00:00.000Z');
    expect(summarizeStory(newestFirst(created, h), NOW)).toEqual(
      summarizeStory(newestFirst(created), NOW),
    );
  });
});
