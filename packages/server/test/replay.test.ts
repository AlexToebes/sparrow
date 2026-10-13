import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVITY_KINDS,
  EVENT_TYPES,
  type Observation,
  type StoredActivity,
} from '@sparrow/shared';
import {
  assignDrive,
  reinstateDrive,
  removeToSpares,
  retireDrive,
  sendForRma,
} from '../src/core/assignment.js';
import { exportData } from '../src/core/backup.js';
import { createDrive, updateDrive } from '../src/core/drives.js';
import { recordHealthChanges } from '../src/core/health-history.js';
import { createFromObservation, importRetired, linkObservation } from '../src/core/inbox.js';
import { createLayoutService } from '../src/core/layout.js';
import { createOldLayout } from './old-layout.js';
import { changeMembership, joinPool, leavePool } from '../src/core/memberships.js';
import { moveDrive } from '../src/core/move.js';
import { createPool, deletePool, updatePool } from '../src/core/pools.js';
import { plain, replay, snapshotState, undoAll } from '../src/core/replay.js';
import {
  applySuggestions,
  dismissSuggestions,
  undismissSuggestions,
} from '../src/core/suggestions.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import { createRepositories } from '../src/db/repositories.js';

// R14 (reversibility, 2026-10-12): the activity log is complete. Replaying every event from empty
// tables rebuilds drives, installations, pools, enclosures, grids and slots exactly, and undoing
// them from now back to the start leaves the tables empty. Health and suggestion events touch no
// tables and are skipped. `updatedAt` columns are bookkeeping and are not part of the comparison.

let opened: OpenedDatabase;
beforeEach(() => {
  opened = openDatabase(':memory:');
});
afterEach(() => opened.sqlite.close());
const db = () => opened.db;

const P = 'fake';
const obs = (serial: string, extra: Partial<Observation> = {}): Observation => ({
  serial,
  health: 'ok',
  lastReportedAt: '2026-03-04T05:06:07.000Z',
  state: 'active',
  ...extra,
});
const snapshot = (observations: Observation[]) =>
  createRepositories(db()).snapshot.put({
    providerId: P,
    observations,
    lastSuccessAt: '2026-03-04T05:06:07.000Z',
    lastAttemptAt: '2026-03-04T05:06:07.000Z',
  });

const activities = (): StoredActivity[] => exportData(db()).data.activities;
const empty = { enclosures: [], grids: [], slots: [], drives: [], installations: [], pools: [] };

/**
 * A scenario that uses every activity kind and every event type. Each step is one user action; after
 * each one the test records the state of the tables so any past state can be compared with a replay.
 */
function runScenario(): { states: ReturnType<typeof plain>[]; counts: number[] } {
  const states: ReturnType<typeof plain>[] = [];
  const counts: number[] = [];
  const step = (fn: () => void) => {
    fn();
    states.push(plain(snapshotState(db())));
    counts.push(activities().length);
  };
  const layout = createLayoutService(db());
  const slots = () => layout.getLayout().enclosures[0]!.grids[0]!.slots.map((s) => s.id);
  let s: string[] = [];
  const ids: Record<string, string> = {};

  step(() => createOldLayout(db())); // layout-updated (the setup wizard: enclosure, grids)
  step(() => {
    // The first grid is the 8 front bays.
    s = slots();
  });
  step(() => {
    ids.tank = createPool(db(), { name: 'tank', layoutLabel: 'raidz2', expectedMembers: 6 }).id;
  }); // pool-edited (created)
  step(() => {
    ids.scratch = createPool(db(), { name: 'scratch' }).id;
  });
  step(() => updatePool(db(), ids.tank!, { layoutLabel: 'raidz1', expectedMembers: 4 }));
  step(() => {
    ids.a = createDrive(db(), { serial: 'A', model: 'M1', capacityBytes: 4e12 }).id;
  }); // drive-added
  step(() => {
    ids.b = createDrive(db(), { serial: 'B', capacityBytes: 4e12 }).id;
    ids.c = createDrive(db(), { serial: 'C' }).id;
    ids.d = createDrive(db(), { serial: 'D' }).id;
    ids.e = createDrive(db(), { serial: 'E' }).id;
    ids.f = createDrive(db(), { serial: 'F' }).id;
  });
  step(() => updateDrive(db(), ids.a!, { serial: 'A-1', notes: 'first' })); // drive-edited (serial renormalised)
  step(() =>
    assignDrive(db(), {
      driveId: ids.a!,
      slotId: s[0]!,
      poolId: ids.tank!,
      installedOn: '2024-01-01',
    }),
  ); // assigned
  step(() => assignDrive(db(), { driveId: ids.b!, slotId: s[1]!, installedOn: null })); // assigned, not recorded
  step(() => updateDrive(db(), ids.b!, { installedOn: '2024-02-02', vendor: 'Acme' })); // + installation-updated
  step(() => joinPool(db(), ids.b!, { poolId: ids.tank!, role: 'hot-spare' })); // pool-joined
  step(() => changeMembership(db(), ids.b!, { role: 'data' })); // pool-role-changed
  step(() => changeMembership(db(), ids.b!, { poolId: ids.scratch! })); // pool-changed
  step(() => leavePool(db(), ids.b!)); // pool-left
  step(() =>
    assignDrive(db(), {
      driveId: ids.c!,
      slotId: s[0]!,
      installedOn: '2025-03-03',
      occupant: { action: 'retire', reason: 'replaced', note: 'old' },
    }),
  ); // replaced (a retired)
  step(() => reinstateDrive(db(), ids.a!, { note: 'false alarm' })); // reinstated
  step(() =>
    moveDrive(db(), ids.c!, { destination: { kind: 'slot', slotId: s[2]! }, date: '2025-04-04' }),
  ); // moved
  step(() =>
    moveDrive(db(), ids.c!, {
      destination: { kind: 'slot', slotId: s[1]!, occupant: { action: 'swap' } },
      date: '2025-05-05',
    }),
  ); // swapped
  step(() =>
    moveDrive(db(), ids.b!, {
      destination: { kind: 'spares' },
      replacement: { driveId: ids.d! },
      date: '2025-06-06',
    }),
  ); // moved (to spares, with a replacement)
  step(() => removeToSpares(db(), ids.d!, { note: 'shelf', removedOn: null })); // removed
  step(() =>
    assignDrive(db(), {
      driveId: ids.d!,
      slotId: s[3]!,
      poolId: ids.tank!,
      installedOn: '2025-06-20',
    }),
  );
  step(() => retireDrive(db(), ids.d!, { reason: 'failed', date: '2025-07-07', note: 'clicks' })); // retired
  step(() => assignDrive(db(), { driveId: ids.e!, slotId: s[3]!, installedOn: '2025-08-08' }));
  step(() => sendForRma(db(), ids.e!, { date: '2025-09-09', note: 'ticket' })); // sent-for-rma
  step(() => reinstateDrive(db(), ids.e!)); // reinstated

  // Provider-driven: the inbox, suggestions and health.
  snapshot([
    obs('F', { model: 'Link Model', capacityBytes: 2e12, wwn: '0xF', driveType: 'HDD' }),
    obs('NEW-1', { model: 'Fresh', capacityBytes: 8e12 }),
    obs('DEAD-1', { state: 'decommissioned', health: 'failed', model: 'Gone' }),
    obs('A-1', { model: 'M1-renamed', capacityBytes: 4e12 }),
  ]);
  step(() =>
    linkObservation(db(), P, 'F', { driveId: ids.f!, slotId: s[4]!, installedOn: '2023-03-03' }),
  ); // discovered-linked
  step(() =>
    createFromObservation(db(), P, 'NEW-1', {
      slotId: s[5]!,
      poolId: ids.scratch!,
      vendor: 'Shop',
    }),
  ); // discovered-created
  step(() => importRetired(db(), P, { items: [{ observationKey: 'DEAD-1', reason: 'other' }] })); // retired-imported
  step(() => applySuggestions(db(), P, ids.a!, ['model'])); // suggestions-applied
  step(() => {
    // The provider now reports a different model for F: a "differs" suggestion, which is dismissed.
    snapshot([obs('F', { model: 'Other Model' }), obs('A-1', { model: 'M1-renamed' })]);
    dismissSuggestions(db(), P, ids.f!, ['model']); // suggestions-dismissed
  });
  step(() => undismissSuggestions(db(), P, ids.f!, ['model'])); // suggestions-restored
  step(() =>
    recordHealthChanges(db(), [obs('F', { health: 'warning' })], '2026-03-05T00:00:00.000Z'),
  ); // health-polled

  // Layout and pool deletions, with full records in the log.
  step(() => layout.updateSlotLabel(s[7]!, { label: 'Spare bay' })); // slot-relabeled
  step(() => {
    const enclosure = layout.createEnclosure({ name: 'Shelf' });
    ids.shelf = enclosure.id;
    ids.rear = layout.createGrid(enclosure.id, {
      name: 'Rear',
      rows: 1,
      columns: 3,
      orientation: 'landscape',
    }).id;
  });
  step(() => layout.updateGrid(ids.rear!, { columns: 4, name: 'Rear bays' })); // grows: slots added
  step(() => layout.updateGrid(ids.rear!, { columns: 2, orientation: 'portrait' })); // shrinks: slots removed
  step(() => layout.renameEnclosure(ids.shelf!, { name: 'Shelf 2' }));
  step(() => layout.deleteGrid(ids.rear!));
  step(() => {
    const enclosure = layout.createEnclosure({ name: 'Temp' });
    layout.createGrid(enclosure.id, { name: 'T', rows: 1, columns: 1, orientation: 'landscape' });
    layout.deleteEnclosure(enclosure.id); // grid-deleted + enclosure-deleted in one activity
  });
  step(() => {
    removeToSpares(db(), ids.f!);
    deletePool(db(), createPool(db(), { name: 'temp' }).id); // pool-edited (deleted)
  });
  return { states, counts };
}

describe('R14: the activity log is complete and reversible', () => {
  it('the scenario uses every activity kind and every event type', () => {
    runScenario();
    const acts = activities();
    const kinds = new Set(acts.map((a) => a.kind));
    expect([...ACTIVITY_KINDS].filter((k) => !kinds.has(k))).toEqual([]);
    const types = new Set(acts.flatMap((a) => a.events.map((e) => e.type)));
    expect([...EVENT_TYPES].filter((t) => !types.has(t))).toEqual([]);
  });

  it('replaying every event from empty tables reproduces the tables exactly', () => {
    runScenario();
    expect(plain(replay(activities()))).toEqual(plain(snapshotState(db())));
  });

  it('every past state can be rebuilt: replaying the first k activities equals the state after step k', () => {
    const { states, counts } = runScenario();
    const acts = activities();
    states.forEach((state, i) => {
      const upTo = acts.filter((a) => a.seq <= counts[i]!);
      expect(plain(replay(upTo)), `after step ${i}`).toEqual(state);
    });
  });

  it('undoing every event from now back to the start leaves the tables empty', () => {
    runScenario();
    const undone = undoAll(snapshotState(db()), activities());
    expect(plain(undone)).toEqual(empty);
  });

  it('undoing the newest activities from now gives back each earlier state', () => {
    const { states, counts } = runScenario();
    const acts = activities();
    states.forEach((state, i) => {
      const newer = acts.filter((a) => a.seq > counts[i]!);
      expect(plain(undoAll(snapshotState(db()), newer)), `back to step ${i}`).toEqual(state);
    });
  });

  it('an exported log replays to the exported tables (the file carries everything)', () => {
    runScenario();
    const file = exportData(db());
    const fresh = openDatabase(':memory:');
    try {
      const rebuilt = plain(replay(file.data.activities));
      expect(rebuilt.drives.map((d) => d.id).sort()).toEqual(
        file.data.drives.map((d) => d.id).sort(),
      );
      expect(rebuilt.installations).toHaveLength(file.data.installations.length);
      expect(rebuilt.pools).toHaveLength(file.data.pools.length);
    } finally {
      fresh.sqlite.close();
    }
  });
});
