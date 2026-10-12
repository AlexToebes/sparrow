import { normalizeSerial, type StoredActivity, type StoredEvent } from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { drives, enclosures, grids, installations, pools, slots } from '../db/schema.js';

// R14 (reversibility): the activity log is complete, so any past state of the records can be rebuilt
// by applying events forward, and any later state taken back by undoing them in reverse. This module
// is that proof in code: it is used by tests only for now (a future "state as of" view could use it).
//
// It models the tables the log describes: enclosures, grids, slots, drives (their own fields),
// installations (with pool and pool role) and pools. Observations of the drive's state
// (`health-changed`) and `suggestion-dismissed` touch none of them and are skipped. `updatedAt`
// columns are bookkeeping and are not tracked.

type Rec = Record<string, unknown>;

export interface ReplayState {
  enclosures: Map<string, Rec>;
  grids: Map<string, Rec>;
  slots: Map<string, Rec>;
  drives: Map<string, Rec>;
  /** Keyed by drive id (the installation's key). */
  installations: Map<string, Rec>;
  pools: Map<string, Rec>;
}

export const emptyState = (): ReplayState => ({
  enclosures: new Map(),
  grids: new Map(),
  slots: new Map(),
  drives: new Map(),
  installations: new Map(),
  pools: new Map(),
});

const strip = (rec: Rec): Rec => {
  const { updatedAt, ...rest } = rec;
  void updatedAt;
  return rest;
};

const records = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]) : []);
const rec = (v: unknown): Rec => (typeof v === 'object' && v !== null ? (v as Rec) : {});
const changesOf = (e: StoredEvent): Record<string, { from: unknown; to: unknown }> =>
  rec(e.payload.changes) as Record<string, { from: unknown; to: unknown }>;

/** The tables as they are in the database now, in the replay model (for comparing with a replay). */
export function snapshotState(db: AppDb): ReplayState {
  const s = emptyState();
  for (const r of db.select().from(enclosures).all()) s.enclosures.set(r.id, strip(r));
  for (const r of db.select().from(grids).all()) s.grids.set(r.id, strip(r));
  for (const r of db.select().from(slots).all()) s.slots.set(r.id, strip(r));
  for (const r of db.select().from(drives).all()) s.drives.set(r.id, strip(r));
  for (const r of db.select().from(installations).all()) s.installations.set(r.driveId, { ...r });
  for (const r of db.select().from(pools).all()) s.pools.set(r.id, strip(r));
  return s;
}

/** Plain, sorted arrays of a state, for deep-equality assertions. */
export function plain(s: ReplayState): Record<keyof ReplayState, Rec[]> {
  const sorted = (m: Map<string, Rec>) =>
    [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
  return {
    enclosures: sorted(s.enclosures),
    grids: sorted(s.grids),
    slots: sorted(s.slots),
    drives: sorted(s.drives),
    installations: sorted(s.installations),
    pools: sorted(s.pools),
  };
}

const setFields = (target: Rec | undefined, fields: Rec) => {
  if (!target) throw new Error('replay: the record an event changes does not exist');
  Object.assign(target, fields);
  if ('serial' in fields) target.serialNormalized = normalizeSerial(String(fields.serial));
};

function need(map: Map<string, Rec>, id: string | null, what: string): Rec {
  const r = id === null ? undefined : map.get(id);
  if (!r) throw new Error(`replay: ${what} ${id} does not exist`);
  return r;
}

/** Sets (apply) or restores (undo) one side of every changed field. */
function applyChanges(target: Rec, e: StoredEvent, side: 'from' | 'to'): void {
  setFields(target, Object.fromEntries(Object.entries(changesOf(e)).map(([f, c]) => [f, c[side]])));
}

const retirementFields = (reason: unknown, date: unknown, note: unknown): Rec => ({
  retirementReason: reason,
  retirementDate: date,
  retirementNote: note,
});

/** Applies one event forward. */
export function applyEvent(s: ReplayState, a: StoredActivity, e: StoredEvent): void {
  const p = e.payload;
  switch (e.type) {
    case 'drive-created':
      s.drives.set(String(p.id), strip(p));
      break;
    case 'drive-updated':
      applyChanges(need(s.drives, e.driveId, 'drive'), e, 'to');
      break;
    case 'drive-linked':
      setFields(
        need(s.drives, e.driveId, 'drive'),
        Object.fromEntries(
          Object.entries(rec(p.filled)).map(([f, c]) => [f, (c as { to: unknown }).to]),
        ),
      );
      break;
    case 'drive-installed':
      s.installations.set(e.driveId!, {
        driveId: e.driveId,
        slotId: e.slotId,
        poolId: e.poolId,
        poolRole: p.poolRole,
        installedOn: a.occurredOn,
      });
      break;
    case 'drive-uninstalled':
      s.installations.delete(e.driveId!);
      break;
    case 'installation-updated':
      applyChanges(need(s.installations, e.driveId, 'installation'), e, 'to');
      break;
    case 'pool-joined':
      setFields(need(s.installations, e.driveId, 'installation'), {
        poolId: e.poolId,
        poolRole: p.poolRole,
      });
      break;
    case 'pool-left':
      setFields(need(s.installations, e.driveId, 'installation'), {
        poolId: null,
        poolRole: null,
      });
      break;
    case 'pool-role-changed':
      setFields(need(s.installations, e.driveId, 'installation'), { poolRole: p.to });
      break;
    case 'drive-retired':
      setFields(
        need(s.drives, e.driveId, 'drive'),
        retirementFields(p.reason, a.occurredOn, p.note),
      );
      break;
    case 'drive-sent-for-rma':
      setFields(
        need(s.drives, e.driveId, 'drive'),
        retirementFields('failed', a.occurredOn, p.note),
      );
      break;
    case 'drive-reinstated':
      setFields(need(s.drives, e.driveId, 'drive'), retirementFields(null, null, null));
      break;
    case 'enclosure-created':
      s.enclosures.set(String(p.id), strip(p));
      break;
    case 'enclosure-renamed':
      setFields(need(s.enclosures, String(p.enclosureId), 'enclosure'), { name: p.to });
      break;
    case 'enclosure-deleted':
      s.enclosures.delete(String(p.id));
      break;
    case 'grid-created': {
      const { slots: created, ...grid } = p;
      s.grids.set(String(grid.id), strip(grid));
      for (const slot of records(created)) s.slots.set(String(slot.id), strip(slot));
      break;
    }
    case 'grid-updated':
      applyChanges(need(s.grids, String(p.gridId), 'grid'), e, 'to');
      for (const slot of records(p.slotsAdded)) s.slots.set(String(slot.id), strip(slot));
      for (const slot of records(p.slotsRemoved)) s.slots.delete(String(slot.id));
      break;
    case 'grid-deleted': {
      s.grids.delete(String(p.id));
      for (const slot of records(p.slots)) s.slots.delete(String(slot.id));
      break;
    }
    case 'slot-relabeled':
      setFields(need(s.slots, e.slotId, 'slot'), { label: p.to });
      break;
    case 'pool-created':
      s.pools.set(String(p.id), strip(p));
      break;
    case 'pool-updated':
      applyChanges(need(s.pools, e.poolId, 'pool'), e, 'to');
      break;
    case 'pool-deleted':
      s.pools.delete(String(p.id));
      break;
    case 'health-changed':
    case 'suggestion-dismissed':
      break; // observations and preferences: no table changes
  }
}

/** Takes one event back (the state must be the one right after it). */
export function undoEvent(s: ReplayState, a: StoredActivity, e: StoredEvent): void {
  const p = e.payload;
  switch (e.type) {
    case 'drive-created':
      s.drives.delete(String(p.id));
      break;
    case 'drive-updated':
      applyChanges(need(s.drives, e.driveId, 'drive'), e, 'from');
      break;
    case 'drive-linked':
      setFields(
        need(s.drives, e.driveId, 'drive'),
        Object.fromEntries(
          Object.entries(rec(p.filled)).map(([f, c]) => [f, (c as { from: unknown }).from]),
        ),
      );
      break;
    case 'drive-installed':
      s.installations.delete(e.driveId!);
      break;
    case 'drive-uninstalled':
      s.installations.set(e.driveId!, {
        driveId: e.driveId,
        slotId: e.slotId,
        poolId: e.poolId,
        poolRole: p.poolRole,
        installedOn: p.installedOn,
      });
      break;
    case 'installation-updated':
      applyChanges(need(s.installations, e.driveId, 'installation'), e, 'from');
      break;
    case 'pool-joined':
      setFields(need(s.installations, e.driveId, 'installation'), {
        poolId: null,
        poolRole: null,
      });
      break;
    case 'pool-left':
      setFields(need(s.installations, e.driveId, 'installation'), {
        poolId: e.poolId,
        poolRole: p.poolRole,
      });
      break;
    case 'pool-role-changed':
      setFields(need(s.installations, e.driveId, 'installation'), { poolRole: p.from });
      break;
    case 'drive-retired':
    case 'drive-sent-for-rma':
      setFields(need(s.drives, e.driveId, 'drive'), retirementFields(null, null, null));
      break;
    case 'drive-reinstated':
      setFields(
        need(s.drives, e.driveId, 'drive'),
        retirementFields(p.previousReason, p.previousDate, p.previousNote),
      );
      break;
    case 'enclosure-created':
      s.enclosures.delete(String(p.id));
      break;
    case 'enclosure-renamed':
      setFields(need(s.enclosures, String(p.enclosureId), 'enclosure'), { name: p.from });
      break;
    case 'enclosure-deleted':
      s.enclosures.set(String(p.id), strip(p));
      break;
    case 'grid-created': {
      s.grids.delete(String(p.id));
      for (const slot of records(p.slots)) s.slots.delete(String(slot.id));
      break;
    }
    case 'grid-updated':
      applyChanges(need(s.grids, String(p.gridId), 'grid'), e, 'from');
      for (const slot of records(p.slotsAdded)) s.slots.delete(String(slot.id));
      for (const slot of records(p.slotsRemoved)) s.slots.set(String(slot.id), strip(slot));
      break;
    case 'grid-deleted': {
      const { slots: removed, ...grid } = p;
      s.grids.set(String(grid.id), strip(grid));
      for (const slot of records(removed)) s.slots.set(String(slot.id), strip(slot));
      break;
    }
    case 'slot-relabeled':
      setFields(need(s.slots, e.slotId, 'slot'), { label: p.from });
      break;
    case 'pool-created':
      s.pools.delete(String(p.id));
      break;
    case 'pool-updated':
      applyChanges(need(s.pools, e.poolId, 'pool'), e, 'from');
      break;
    case 'pool-deleted':
      s.pools.set(String(p.id), strip(p));
      break;
    case 'health-changed':
    case 'suggestion-dismissed':
      break;
  }
  void a;
}

const bySeq = (activities: readonly StoredActivity[]) =>
  [...activities].sort((x, y) => x.seq - y.seq);

/** Rebuilds the state by applying every event, in log order, to empty tables. */
export function replay(activities: readonly StoredActivity[]): ReplayState {
  const s = emptyState();
  for (const a of bySeq(activities)) {
    for (const e of [...a.events].sort((x, y) => x.ord - y.ord)) applyEvent(s, a, e);
  }
  return s;
}

/** Takes `state` (the state after the whole log) back, newest event first. */
export function undoAll(state: ReplayState, activities: readonly StoredActivity[]): ReplayState {
  for (const a of bySeq(activities).reverse()) {
    for (const e of [...a.events].sort((x, y) => y.ord - x.ord)) undoEvent(state, a, e);
  }
  return state;
}
