import { asc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { SlotHistory, SlotHistoryEntry, SlotHistoryOutcome } from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { getGrid, getSlot } from '../db/layout-repo.js';
import { drives, events } from '../db/schema.js';
import { notFound } from './errors.js';
import type { DbTransaction } from './events.js';

// R74: the history of one bay, computed on every read from the event log (never stored). The bay is
// referenced by its stable slot id (R39), so renaming a bay or its grid keeps its history.

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

interface Row {
  rowid: number;
  driveId: string | null;
  type: string;
  at: string;
  payload: Record<string, unknown>;
}

const eventRows = (db: DbTransaction, where: ReturnType<typeof sql>): Row[] =>
  db
    .select({ ...getTableColumns(events), rowid: sql<number>`rowid` })
    .from(events)
    .where(where)
    .orderBy(asc(sql`rowid`))
    .all();

export function getSlotHistory(appDb: AppDb, slotId: string): SlotHistory {
  return appDb.transaction((db) => slotHistoryIn(db, slotId));
}

function slotHistoryIn(db: DbTransaction, slotId: string): SlotHistory {
  const slot = getSlot(db, slotId);
  if (!slot) throw notFound(`Slot ${slotId} not found`);
  const grid = getGrid(db, slot.gridId);
  const label = slot.label ?? `Slot ${slot.position + 1}`;

  const slotEvents = eventRows(
    db,
    sql`${events.type} IN ('drive-installed', 'drive-removed') AND ${events.driveId} IS NOT NULL
      AND json_extract(${events.payload}, '$.slotId') = ${slotId}`,
  );
  const driveIds = [...new Set(slotEvents.map((e) => e.driveId as string))];
  if (driveIds.length === 0) {
    return { slot: { id: slotId, label, gridName: grid?.name ?? '' }, entries: [] };
  }
  // A retired / RMA event with this bay as its slot is the tail of the removal just before it.
  const exits = eventRows(
    db,
    sql`${events.type} IN ('drive-retired', 'drive-sent-for-rma')
      AND json_extract(${events.payload}, '$.slotId') = ${slotId}`,
  );
  const driveRows = db.select().from(drives).where(inArray(drives.id, driveIds)).all();
  const driveById = new Map(driveRows.map((d) => [d.id, d]));

  interface Open {
    driveId: string;
    installedOn: string | null;
    installedRecordedAt: string | null;
    order: number;
  }
  const open = new Map<string, Open>();
  const done: (SlotHistoryEntry & { order: number })[] = [];

  const outcomeOf = (removal: Row): SlotHistoryOutcome => {
    const movedTo = str(removal.payload.movedToSlotId);
    if (movedTo !== null) {
      const target = getSlot(db, movedTo);
      const targetGrid = target ? getGrid(db, target.gridId) : undefined;
      // The target may be gone; its install event still holds the names as they were.
      const arrival = eventRows(
        db,
        sql`${events.type} = 'drive-installed' AND ${events.driveId} = ${removal.driveId}
          AND json_extract(${events.payload}, '$.slotId') = ${movedTo}
          AND rowid > ${removal.rowid}`,
      )[0];
      return {
        kind: 'moved',
        toSlotId: movedTo,
        toLabel: target
          ? (target.label ?? `Slot ${target.position + 1}`)
          : (str(arrival?.payload.slotLabel) ?? 'a removed bay'),
        toGridName: target ? (targetGrid?.name ?? '') : (str(arrival?.payload.gridName) ?? ''),
      };
    }
    const retired = exits.find(
      (e) => e.driveId === removal.driveId && e.type === 'drive-retired' && e.rowid > removal.rowid,
    );
    if (retired) {
      const rma = exits.find(
        (e) =>
          e.driveId === removal.driveId &&
          e.type === 'drive-sent-for-rma' &&
          e.rowid > retired.rowid,
      );
      return rma ? { kind: 'rma' } : { kind: 'retired', reason: str(retired.payload.reason) };
    }
    return { kind: 'spares' };
  };

  const info = (driveId: string) => {
    const d = driveById.get(driveId);
    return {
      serial: d?.serial ?? driveId,
      capacityBytes: d?.capacityBytes ?? null,
      driveType: d?.driveType ?? null,
    };
  };

  for (const e of slotEvents) {
    const driveId = e.driveId as string;
    if (e.type === 'drive-installed') {
      const stale = open.get(driveId);
      if (stale) {
        // Two installs in a row: the earlier stay has no recorded end.
        done.push({
          driveId,
          ...info(driveId),
          installedOn: stale.installedOn,
          installedRecordedAt: stale.installedRecordedAt,
          removedOn: null,
          removedRecordedAt: null,
          outcome: { kind: 'spares' },
          order: stale.order,
        });
      }
      open.set(driveId, {
        driveId,
        installedOn: str(e.payload.installedOn),
        installedRecordedAt: e.at,
        order: e.rowid,
      });
    } else {
      const start = open.get(driveId);
      open.delete(driveId);
      done.push({
        driveId,
        ...info(driveId),
        installedOn: start ? start.installedOn : str(e.payload.installedOn),
        installedRecordedAt: start ? start.installedRecordedAt : null,
        removedOn: str(e.payload.removedOn),
        removedRecordedAt: e.at,
        outcome: outcomeOf(e),
        order: start ? start.order : e.rowid,
      });
    }
  }

  const occupant = db.select().from(drives).where(eq(drives.slotId, slotId)).get();
  const entries = [...done];
  for (const o of open.values()) {
    const here = occupant?.id === o.driveId;
    entries.push({
      driveId: o.driveId,
      ...info(o.driveId),
      installedOn: o.installedOn,
      installedRecordedAt: o.installedRecordedAt,
      removedOn: null,
      removedRecordedAt: null,
      outcome: here ? null : { kind: 'spares' },
      order: o.order,
    });
  }
  entries.sort((a, b) => b.order - a.order);
  return {
    slot: { id: slotId, label, gridName: grid?.name ?? '' },
    entries: entries.map((e) => {
      const entry: SlotHistoryEntry & { order?: number } = { ...e };
      delete entry.order;
      return entry;
    }),
  };
}
