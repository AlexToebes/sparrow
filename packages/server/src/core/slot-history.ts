import { and, asc, eq, inArray } from 'drizzle-orm';
import type { SlotHistory, SlotHistoryEntry, SlotHistoryOutcome } from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { getGrid, getSlot } from '../db/layout-repo.js';
import { activities, drives, events } from '../db/schema.js';
import { slotDisplayLabel, type DbTransaction } from './activities.js';
import { notFound } from './errors.js';
import { installationInSlot } from './installations.js';

// R74: the history of one bay, computed on every read from the log, never stored. The bay is referenced
// by its stable slot id (R39), so renaming a bay or its grid keeps its history, and deleting the grid
// keeps the label and grid name copied into the events. The occupancy intervals come from this bay's
// drive-installed and drive-uninstalled events (and installation-updated date edits). HOW a drive left
// and WHO took the bay are read from the OTHER events of the SAME activity: its retirement or RMA, the
// bay it was installed in again (moved, or swapped), the drive installed here in its place. Events of
// different activities are never paired.

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function getSlotHistory(appDb: AppDb, slotId: string): SlotHistory {
  return appDb.transaction((db) => slotHistoryIn(db, slotId));
}

interface Open {
  driveId: string;
  installedOn: string | null;
  installedRecordedAt: string | null;
  order: number;
}

type Finished = Omit<SlotHistoryEntry, 'serial' | 'capacityBytes' | 'driveType'> & {
  order: number;
};

type EventRow = typeof events.$inferSelect;

function slotHistoryIn(db: DbTransaction, slotId: string): SlotHistory {
  const slot = getSlot(db, slotId);
  if (!slot) throw notFound(`Slot ${slotId} not found`);
  const grid = getGrid(db, slot.gridId);
  const header = { id: slotId, label: slotDisplayLabel(slot), gridName: grid?.name ?? '' };

  const rows = db
    .select({
      event: events,
      seq: activities.seq,
      kind: activities.kind,
      recordedAt: activities.recordedAt,
      occurredOn: activities.occurredOn,
    })
    .from(events)
    .innerJoin(activities, eq(activities.id, events.activityId))
    .where(
      and(
        eq(events.slotId, slotId),
        inArray(events.type, ['drive-installed', 'drive-uninstalled', 'installation-updated']),
      ),
    )
    .orderBy(asc(activities.seq), asc(events.ord))
    .all();
  if (rows.length === 0) return { slot: header, entries: [] };

  // The other events of the same activities, for the outcome of each departure.
  const siblings = new Map<string, EventRow[]>();
  for (const e of db
    .select()
    .from(events)
    .where(inArray(events.activityId, [...new Set(rows.map((r) => r.event.activityId))]))
    .all()) {
    siblings.set(e.activityId, [...(siblings.get(e.activityId) ?? []), e]);
  }

  const driveIds = [
    ...new Set(
      [...siblings.values()].flatMap((l) => l.flatMap((e) => (e.driveId ? [e.driveId] : []))),
    ),
  ];
  const driveById = new Map(
    db
      .select()
      .from(drives)
      .where(inArray(drives.id, driveIds))
      .all()
      .map((d) => [d.id, d]),
  );
  const info = (driveId: string) => {
    const d = driveById.get(driveId);
    return {
      serial: d?.serial ?? driveId,
      capacityBytes: d?.capacityBytes ?? null,
      driveType: d?.driveType ?? null,
    };
  };

  /** Where a drive went: the bay as it is now, else as the event copied it (it may be gone). */
  const destination = (arrival: EventRow) => {
    const id = arrival.slotId!;
    const target = getSlot(db, id);
    return {
      toSlotId: id,
      toLabel: target ? slotDisplayLabel(target) : (arrival.slotLabel ?? 'a removed bay'),
      toGridName: target ? (getGrid(db, target.gridId)?.name ?? '') : (arrival.gridName ?? ''),
    };
  };

  const open = new Map<string, Open>();
  const done: Finished[] = [];

  for (const { event: e, seq, kind, recordedAt, occurredOn } of rows) {
    const order = seq * 10_000 + e.ord;
    const driveId = e.driveId;
    if (!driveId) continue;
    const p = e.payload;

    if (e.type === 'drive-installed') {
      const stale = open.get(driveId);
      if (stale) {
        // Two arrivals in a row: the earlier stay has no recorded end.
        done.push({
          driveId,
          installedOn: stale.installedOn,
          installedRecordedAt: stale.installedRecordedAt,
          removedOn: null,
          removedRecordedAt: null,
          outcome: { kind: 'spares' },
          replacedBy: null,
          order: stale.order,
        });
      }
      // The activity's day is the installation day (R68).
      open.set(driveId, {
        driveId,
        installedOn: occurredOn,
        installedRecordedAt: recordedAt,
        order,
      });
    } else if (e.type === 'installation-updated') {
      const to = (p.changes as { installedOn?: { to?: unknown } } | undefined)?.installedOn?.to;
      if (to === undefined) continue;
      const begun = open.get(driveId);
      if (begun) begun.installedOn = str(to);
    } else {
      const sibs = siblings.get(e.activityId) ?? [];
      const mine = sibs.filter((x) => x.driveId === driveId);
      const rma = mine.find((x) => x.type === 'drive-sent-for-rma');
      const retired = mine.find((x) => x.type === 'drive-retired');
      const arrival = mine.find((x) => x.type === 'drive-installed');
      let outcome: SlotHistoryOutcome;
      if (rma) outcome = { kind: 'rma' };
      else if (retired) outcome = { kind: 'retired', reason: str(retired.payload.reason) };
      else if (arrival && kind === 'swapped') {
        const other = sibs.find((x) => x.type === 'drive-uninstalled' && x.driveId !== driveId);
        outcome = other?.driveId
          ? {
              kind: 'swapped',
              withDriveId: other.driveId,
              withSerial: info(other.driveId).serial,
              ...destination(arrival),
            }
          : { kind: 'moved', ...destination(arrival) };
      } else if (arrival) outcome = { kind: 'moved', ...destination(arrival) };
      else outcome = { kind: 'spares' };

      // The drive installed in this very bay in the same activity took its place.
      const taker =
        outcome.kind === 'swapped'
          ? undefined
          : sibs.find(
              (x) => x.type === 'drive-installed' && x.slotId === slotId && x.driveId !== driveId,
            );
      const begun = open.get(driveId);
      open.delete(driveId);
      done.push({
        driveId,
        installedOn: begun ? begun.installedOn : str(p.installedOn),
        installedRecordedAt: begun ? begun.installedRecordedAt : null,
        removedOn: occurredOn, // the activity's day is the removal day (R69)
        removedRecordedAt: recordedAt,
        outcome,
        replacedBy: taker?.driveId ? { driveId: taker.driveId, ...info(taker.driveId) } : null,
        order: begun ? begun.order : order,
      });
    }
  }

  const occupant = installationInSlot(db, slotId);
  const entries: Finished[] = [...done];
  for (const o of open.values()) {
    entries.push({
      driveId: o.driveId,
      installedOn: o.installedOn,
      installedRecordedAt: o.installedRecordedAt,
      removedOn: null,
      removedRecordedAt: null,
      outcome: occupant?.driveId === o.driveId ? null : { kind: 'spares' },
      replacedBy: null,
      order: o.order,
    });
  }
  entries.sort((a, b) => b.order - a.order);
  return {
    slot: header,
    entries: entries.map((e) => ({
      ...info(e.driveId),
      driveId: e.driveId,
      installedOn: e.installedOn,
      installedRecordedAt: e.installedRecordedAt,
      removedOn: e.removedOn,
      removedRecordedAt: e.removedRecordedAt,
      outcome: e.outcome,
      replacedBy: e.replacedBy,
    })),
  };
}
