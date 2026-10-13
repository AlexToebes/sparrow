import { describe, expect, it } from 'vitest';
import { ACTIVITY_KINDS, type Activity, type ActivityKind } from '@sparrow/shared';
import { feedItem, feedItems, KIND_ICON } from '../src/lib/recentChanges';
import { act, ev } from './activities';

const R = '2026-10-11T12:00:00.000Z';
const d = (
  id: string,
  serial: string,
  size: number | null = null,
): [string, string, number | null] => [id, serial, size];
const bayAt = (n: string): [string, string, string] => [`s${n}`, n, 'Front bays'];

// One activity per kind, hand-written. A Record over every kind, so a new kind fails to compile here
// and in the loop below until it has wording (R75).
const SAMPLES: Record<ActivityKind, { activity: Activity; text: string }> = {
  'drive-added': {
    activity: act('drive-added', R, null, [ev('drive-created', { drive: d('d1', 'ZL1', 8e12) })]),
    text: 'ZL1 (8 TB) added to Sparrow',
  },
  'discovered-created': {
    activity: act('discovered-created', R, null, [
      ev('drive-created', { drive: d('d1', 'ZL1') }),
      ev('drive-installed', {
        drive: d('d1', 'ZL1'),
        slot: bayAt('3'),
        pool: ['p1', 'tank'],
        payload: { poolRole: 'data' },
      }),
    ]),
    text: 'ZL1 found in the NAS and added · installed in Front bays, 3',
  },
  'discovered-linked': {
    activity: act('discovered-linked', R, null, [ev('drive-linked', { drive: d('d1', 'ZL1') })]),
    text: 'ZL1 linked to a drive in the NAS',
  },
  'retired-imported': {
    activity: act('retired-imported', R, '2026-01-02', [
      ev('drive-created', { drive: d('d1', 'ZL1', 4e12) }),
      ev('drive-retired', { drive: d('d1', 'ZL1'), payload: { reason: 'failed' } }),
    ]),
    text: 'ZL1 (4 TB) imported as retired (failed)',
  },
  'drive-edited': {
    activity: act('drive-edited', R, null, [
      ev('drive-updated', {
        drive: d('d1', 'ZL1'),
        payload: { changes: { model: { from: 'a', to: 'b' } } },
      }),
    ]),
    text: 'ZL1 details edited (model)',
  },
  'suggestions-applied': {
    activity: act('suggestions-applied', R, null, [
      ev('drive-updated', {
        drive: d('d1', 'ZL1'),
        payload: { changes: { model: { from: 'a', to: 'b' } } },
      }),
    ]),
    text: 'ZL1 updated from the provider (model)',
  },
  'suggestions-dismissed': {
    activity: act('suggestions-dismissed', R, null, [
      ev('suggestion-dismissed', {
        drive: d('d1', 'ZL1'),
        payload: { field: 'model', value: 'x' },
      }),
    ]),
    text: 'Dismissed suggested model for ZL1',
  },
  'suggestions-restored': {
    activity: act('suggestions-restored', R, null, [
      ev('suggestion-dismissed', {
        drive: d('d1', 'ZL1'),
        payload: { field: 'model', value: null },
      }),
    ]),
    text: 'Restored suggested model for ZL1',
  },
  assigned: {
    activity: act('assigned', R, '2026-10-11', [
      ev('drive-installed', {
        drive: d('d1', 'ZL1', 8e12),
        slot: bayAt('2'),
        pool: ['p1', 'tank'],
        payload: { poolRole: 'hot-spare' },
      }),
    ]),
    text: 'ZL1 (8 TB) installed in Front bays, 2 · tank (hot spare)',
  },
  replaced: {
    activity: act('replaced', R, '2026-10-11', [
      ev('drive-uninstalled', { drive: d('d2', 'ZL2ABC03'), slot: bayAt('3') }),
      ev('drive-retired', { drive: d('d2', 'ZL2ABC03'), payload: { reason: 'failed' } }),
      ev('drive-installed', { drive: d('d1', 'ZL2SPR01', 8e12), slot: bayAt('3') }),
    ]),
    text: 'ZL2SPR01 (8 TB) replaced ZL2ABC03 in Front bays, 3 · ZL2ABC03 retired (failed)',
  },
  removed: {
    activity: act('removed', R, null, [
      ev('drive-uninstalled', { drive: d('d1', 'ZL1'), slot: bayAt('4') }),
    ]),
    text: 'ZL1 removed from Front bays, 4 · back to spares',
  },
  retired: {
    activity: act('retired', R, null, [
      ev('drive-uninstalled', { drive: d('d1', 'ZL1'), slot: bayAt('4') }),
      ev('drive-retired', { drive: d('d1', 'ZL1'), payload: { reason: 'old' } }),
    ]),
    text: 'ZL1 retired from Front bays, 4 (old)',
  },
  'sent-for-rma': {
    activity: act('sent-for-rma', R, null, [
      ev('drive-uninstalled', { drive: d('d1', 'ZL1'), slot: bayAt('4') }),
      ev('drive-sent-for-rma', { drive: d('d1', 'ZL1') }),
    ]),
    text: 'ZL1 sent for RMA from Front bays, 4',
  },
  reinstated: {
    activity: act('reinstated', R, null, [ev('drive-reinstated', { drive: d('d1', 'ZL1') })]),
    text: 'ZL1 reinstated as a spare',
  },
  moved: {
    activity: act('moved', R, '2026-10-10', [
      ev('drive-uninstalled', { drive: d('d1', 'ZL1'), slot: bayAt('1') }),
      ev('drive-installed', { drive: d('d1', 'ZL1'), slot: bayAt('5') }),
    ]),
    text: 'ZL1 moved Front bays, 1 → Front bays, 5',
  },
  swapped: {
    activity: act('swapped', R, null, [
      ev('drive-uninstalled', { drive: d('d1', 'ZL1'), slot: bayAt('2') }),
      ev('drive-uninstalled', { drive: d('d2', 'ZL2'), slot: bayAt('1') }),
      ev('drive-installed', { drive: d('d1', 'ZL1'), slot: bayAt('1') }),
      ev('drive-installed', { drive: d('d2', 'ZL2'), slot: bayAt('2') }),
    ]),
    text: 'Swapped ZL1 (Front bays, 2) and ZL2 (Front bays, 1)',
  },
  'pool-joined': {
    activity: act('pool-joined', R, null, [
      ev('pool-joined', {
        drive: d('d1', 'ZL1'),
        pool: ['p1', 'tank'],
        payload: { poolRole: 'data' },
      }),
    ]),
    text: 'ZL1 joined pool tank (data)',
  },
  'pool-left': {
    activity: act('pool-left', R, null, [
      ev('pool-left', {
        drive: d('d1', 'ZL1'),
        pool: ['p1', 'tank'],
        payload: { poolRole: 'data' },
      }),
    ]),
    text: 'ZL1 left pool tank',
  },
  'pool-role-changed': {
    activity: act('pool-role-changed', R, null, [
      ev('pool-role-changed', {
        drive: d('d1', 'ZL1'),
        pool: ['p1', 'tank'],
        payload: { from: 'data', to: 'hot-spare' },
      }),
    ]),
    text: 'ZL1 changed role data → hot spare in tank',
  },
  'pool-changed': {
    activity: act('pool-changed', R, null, [
      ev('pool-left', { drive: d('d1', 'ZL1'), pool: ['p1', 'tank'] }),
      ev('pool-joined', {
        drive: d('d1', 'ZL1'),
        pool: ['p2', 'backup'],
        payload: { poolRole: 'data' },
      }),
    ]),
    text: 'ZL1 changed pool from tank to backup (data)',
  },
  'health-polled': {
    activity: act('health-polled', R, null, [
      ev('health-changed', { drive: d('d1', 'ZL1'), payload: { from: 'ok', to: 'warning' } }),
    ]),
    text: 'Health: ZL1 OK → Warning',
  },
  'layout-updated': {
    activity: act('layout-updated', R, null, [
      ev('grid-updated', {
        payload: {
          gridId: 'g1',
          changes: { rows: { from: 2, to: 3 } },
          after: { name: 'Front bays', rows: 3, columns: 4, orientation: 'landscape' },
        },
      }),
    ]),
    text: "Grid 'Front bays' resized 4 × 2 → 4 × 3",
  },
  'pool-edited': {
    activity: act('pool-edited', R, null, [ev('pool-created', { pool: ['p1', 'tank'] })]),
    text: 'Pool tank created',
  },
};

describe('R75: neutral wording of the recent changes feed', () => {
  it('R75: every activity kind has wording, an icon, and no fallback', () => {
    for (const kind of ACTIVITY_KINDS) {
      const sample = SAMPLES[kind];
      expect(sample, `no sample for ${kind}`).toBeDefined();
      const item = feedItem(sample.activity);
      expect(item.kind).toBe(kind);
      expect(item.icon).toBe(KIND_ICON[kind]);
      expect(item.text, kind).toBe(sample.text);
      expect(item.text, `${kind} fell back to its name`).not.toBe(kind.replace(/-/g, ' '));
    }
  });

  it('R75: an unknown kind from a newer server still reads as something', () => {
    const odd = act('assigned', R, null, []);
    expect(feedItem({ ...odd, kind: 'something-new' as ActivityKind }).text).toBe('something new');
  });

  it('R75: serials link to the drive and bays to the bay history', () => {
    const parts = feedItem(SAMPLES.replaced.activity).parts;
    expect(parts).toContainEqual({ text: 'ZL2SPR01', to: '/drives?drive=d1' });
    expect(parts).toContainEqual({ text: 'Front bays, 3', to: '/?slot=s3&view=slot' });
  });

  it('R75: a Move to another bay with a spare taking the vacated bay reads as one sentence each', () => {
    const a = act('moved', R, null, [
      ev('drive-uninstalled', { drive: d('d1', 'ZL1'), slot: bayAt('1') }),
      ev('drive-installed', { drive: d('d1', 'ZL1'), slot: bayAt('5') }),
      ev('drive-installed', { drive: d('d3', 'ZL3', 4e12), slot: bayAt('1') }),
    ]);
    expect(feedItem(a).text).toBe(
      'ZL1 moved Front bays, 1 → Front bays, 5 · ZL3 (4 TB) took Front bays, 1',
    );
  });

  it('R75: a move that displaces a drive says what became of it', () => {
    const a = act('moved', R, null, [
      ev('drive-uninstalled', { drive: d('d1', 'ZL1'), slot: bayAt('1') }),
      ev('drive-uninstalled', { drive: d('d2', 'ZL2'), slot: bayAt('5') }),
      ev('drive-installed', { drive: d('d1', 'ZL1'), slot: bayAt('5') }),
    ]);
    expect(feedItem(a).text).toBe(
      'ZL1 moved Front bays, 1 → Front bays, 5, replacing ZL2 · ZL2 back to spares',
    );
  });

  it('R75: a health poll lists every drive and the icon follows the worst state', () => {
    const a = act('health-polled', R, null, [
      ev('health-changed', { drive: d('d1', 'ZL1'), payload: { from: 'ok', to: 'warning' } }),
      ev('health-changed', { drive: d('d2', 'ZL2'), payload: { from: null, to: 'failed' } }),
    ]);
    const item = feedItem(a);
    expect(item.text).toBe('Health: ZL1 OK → Warning, ZL2 first reported Failed');
    expect(item.health).toBe('failed');
  });

  it('R75: layout wording for each layout event', () => {
    const text = (...events: Parameters<typeof act>[3]) =>
      feedItem(act('layout-updated', R, null, events)).text;
    expect(
      text(
        ev('enclosure-created', { payload: { name: 'NAS' } }),
        ev('grid-created', { payload: { name: 'Front bays', rows: 2, columns: 4 } }),
        ev('grid-created', { payload: { name: 'Rear', rows: 1, columns: 2 } }),
      ),
    ).toBe("Enclosure 'NAS' created with 'Front bays', 'Rear'");
    // R77: the setup wizard's activity also creates pools.
    expect(
      text(
        ev('enclosure-created', { payload: { name: 'NAS' } }),
        ev('grid-created', { payload: { name: 'Front bays', rows: 2, columns: 4 } }),
        ev('pool-created', { payload: { name: 'tank' } }),
        ev('pool-created', { payload: { name: 'scratch' } }),
      ),
    ).toBe("Enclosure 'NAS' created with 'Front bays' and pools 'tank', 'scratch'");
    expect(text(ev('enclosure-renamed', { payload: { from: 'A', to: 'B' } }))).toBe(
      "Enclosure 'A' renamed to 'B'",
    );
    expect(text(ev('enclosure-deleted', { payload: { name: 'B' } }))).toBe("Enclosure 'B' deleted");
    expect(text(ev('grid-created', { payload: { name: 'X', rows: 2, columns: 4 } }))).toBe(
      "Grid 'X' created (4 × 2)",
    );
    expect(text(ev('grid-deleted', { payload: { name: 'X' } }))).toBe("Grid 'X' deleted");
    expect(
      text(ev('grid-updated', { payload: { changes: { name: { from: 'X', to: 'Y' } } } })),
    ).toBe("Grid 'X' renamed to 'Y'");
    expect(
      text(
        ev('grid-updated', {
          payload: {
            changes: { orientation: { from: 'landscape', to: 'portrait' } },
            after: { name: 'Rear', rows: 2, columns: 4, orientation: 'portrait' },
          },
        }),
      ),
    ).toBe("Grid 'Rear' flipped to portrait");
    expect(
      text(
        ev('slot-relabeled', {
          slot: ['s1', 'Top', 'Front bays'],
          payload: { from: 'Bay 1', to: 'Top' },
        }),
      ),
    ).toBe("Bay 'Bay 1' renamed to Front bays, Top");
  });

  it('R75: pool record wording', () => {
    const text = (e: ReturnType<typeof ev>) => feedItem(act('pool-edited', R, null, [e])).text;
    expect(text(ev('pool-deleted', { pool: ['p1', 'tank'] }))).toBe('Pool tank deleted');
    expect(
      text(
        ev('pool-updated', {
          pool: ['p1', 'tank'],
          payload: { changes: { name: { from: 'tank', to: 'big' } } },
        }),
      ),
    ).toBe('Pool tank renamed to big');
    expect(
      text(
        ev('pool-updated', {
          pool: ['p1', 'tank'],
          payload: { changes: { expectedMembers: { from: 4, to: 5 } } },
        }),
      ),
    ).toBe('Pool tank updated (expected drives)');
  });

  it('R75: the date is the effective date, with the recorded day when it differs', () => {
    const logged = new Date(R);
    const day = (n: Date) =>
      `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
    const same = feedItem(
      act('reinstated', R, null, [ev('drive-reinstated', { drive: d('d1', 'ZL1') })]),
    );
    expect(same).toMatchObject({ date: day(logged), recorded: null });
    const earlier = feedItem(
      act('reinstated', R, '2026-01-02', [ev('drive-reinstated', { drive: d('d1', 'ZL1') })]),
    );
    expect(earlier).toMatchObject({ date: '2026-01-02', recorded: day(logged) });
  });

  it('R75: feedItems sorts newest first by seq', () => {
    const a = act('reinstated', R, null, [ev('drive-reinstated', { drive: d('d1', 'A') })], {
      seq: 10,
    });
    const b = act('reinstated', R, null, [ev('drive-reinstated', { drive: d('d1', 'B') })], {
      seq: 11,
    });
    expect(feedItems([a, b]).map((i) => i.seq)).toEqual([11, 10]);
  });
});
