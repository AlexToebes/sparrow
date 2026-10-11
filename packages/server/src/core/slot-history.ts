import { asc, eq, inArray, sql } from 'drizzle-orm';
import type {
  EventLinks,
  EventSlotLink,
  SlotHistory,
  SlotHistoryEntry,
  SlotHistoryOutcome,
} from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { getGrid, getSlot } from '../db/layout-repo.js';
import { drives, events, eventSlots } from '../db/schema.js';
import { notFound } from './errors.js';
import { loadLinks, slotDisplayLabel, type DbTransaction } from './events.js';

// R74: the history of one bay, computed on every read from the events linked to the slot
// (event_slots, indexed by slot id), never stored. The bay is referenced by its stable slot id
// (R39), so renaming a bay or its grid keeps its history, and deleting the grid keeps the label and
// grid name copied into the links. Each event is read by its type and link roles:
//   `to`   a drive arrived here (installed, moved, swapped, or the incoming drive of a replacement)
//   `from` a drive left here   (removed, retired, RMA, moved, swapped)
//   `at`   the bay of a replacement: the outgoing drive leaves, the incoming drive arrives

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

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

function slotHistoryIn(db: DbTransaction, slotId: string): SlotHistory {
  const slot = getSlot(db, slotId);
  if (!slot) throw notFound(`Slot ${slotId} not found`);
  const grid = getGrid(db, slot.gridId);
  const header = { id: slotId, label: slotDisplayLabel(slot), gridName: grid?.name ?? '' };

  const rows = db
    .select({
      id: events.id,
      type: events.type,
      at: events.at,
      payload: events.payload,
      rowid: sql<number>`"events".rowid`,
    })
    .from(events)
    .where(
      inArray(
        events.id,
        db.select({ id: eventSlots.eventId }).from(eventSlots).where(eq(eventSlots.slotId, slotId)),
      ),
    )
    .orderBy(asc(sql`"events".rowid`))
    .all();
  if (rows.length === 0) return { slot: header, entries: [] };

  const links = loadLinks(
    db,
    rows.map((r) => r.id),
  );
  const driveIds = [...new Set([...links.values()].flatMap((l) => l.drives.map((d) => d.driveId)))];
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
  const destination = (link: EventSlotLink | undefined, toSlotId: string | null) => {
    const id = link?.slotId ?? toSlotId;
    if (id === null) return null;
    const target = getSlot(db, id);
    return {
      toSlotId: id,
      toLabel: target ? slotDisplayLabel(target) : (link?.slotLabel ?? 'a removed bay'),
      toGridName: target ? (getGrid(db, target.gridId)?.name ?? '') : (link?.gridName ?? ''),
    };
  };

  const open = new Map<string, Open>();
  const done: Finished[] = [];

  const start = (
    driveId: string,
    installedOn: string | null,
    recordedAt: string,
    order: number,
    mode: 'replace' | 'keep',
  ) => {
    const stale = open.get(driveId);
    if (stale) {
      if (mode === 'keep') return; // the same arrival, read from the other bay's event
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
    open.set(driveId, { driveId, installedOn, installedRecordedAt: recordedAt, order });
  };

  const end = (
    driveId: string,
    e: { at: string; order: number },
    result: {
      outcome: SlotHistoryOutcome;
      removedOn: string | null;
      /** installedOn as the leaving event remembers it, for a stay whose arrival was never logged. */
      installedOn: string | null;
      replacedBy?: SlotHistoryEntry['replacedBy'];
    },
  ) => {
    const begun = open.get(driveId);
    open.delete(driveId);
    done.push({
      driveId,
      installedOn: begun ? begun.installedOn : result.installedOn,
      installedRecordedAt: begun ? begun.installedRecordedAt : null,
      removedOn: result.removedOn,
      removedRecordedAt: e.at,
      outcome: result.outcome,
      replacedBy: result.replacedBy ?? null,
      order: begun ? begun.order : e.order,
    });
  };

  for (const row of rows) {
    const l: EventLinks = links.get(row.id)!;
    const here = new Set(l.slots.filter((s) => s.slotId === slotId).map((s) => s.role));
    const subject = l.drives.find((d) => d.role === 'subject')?.driveId;
    const p = row.payload;
    const ev = { at: row.at, order: row.rowid };
    const otherSlot = (role: 'to' | 'at') =>
      l.slots.find((s) => s.role === role && s.slotId !== slotId);

    switch (row.type) {
      case 'drive-installed':
        if (subject && here.has('to'))
          start(subject, str(p.installedOn), row.at, row.rowid, 'replace');
        break;
      case 'drive-removed':
        if (subject && here.has('from')) {
          end(subject, ev, {
            outcome: { kind: 'spares' },
            removedOn: str(p.removedOn),
            installedOn: str(p.installedOn),
          });
        }
        break;
      case 'drive-retired':
      case 'drive-sent-for-rma':
        if (subject && here.has('from')) {
          end(subject, ev, {
            outcome:
              row.type === 'drive-sent-for-rma'
                ? { kind: 'rma' }
                : { kind: 'retired', reason: str(p.reason) },
            removedOn: str(p.date),
            installedOn: str(p.installedOn),
          });
        }
        break;
      case 'drive-moved': {
        if (!subject) break;
        if (here.has('from')) {
          const to = destination(otherSlot('to'), null);
          end(subject, ev, {
            outcome: to ? { kind: 'moved', ...to } : { kind: 'spares' },
            removedOn: str(p.date),
            installedOn: str(p.installedOn),
          });
        }
        if (here.has('to')) start(subject, str(p.date), row.at, row.rowid, 'replace');
        break;
      }
      case 'drives-swapped': {
        const moves = Array.isArray(p.moves) ? p.moves.filter(isRecord) : [];
        const date = str(p.date);
        for (const m of moves) {
          const id = str(m.driveId);
          if (id && m.fromSlotId === slotId) {
            const other = moves.find((x) => x !== m);
            const to = destination(
              l.slots.find((s) => s.role === 'to' && s.slotId === str(m.toSlotId)),
              str(m.toSlotId),
            );
            const withId = str(other?.driveId);
            if (to && withId) {
              end(id, ev, {
                outcome: {
                  kind: 'swapped',
                  withDriveId: withId,
                  withSerial: info(withId).serial,
                  ...to,
                },
                removedOn: date,
                installedOn: str(m.installedOn),
              });
            }
          }
        }
        for (const m of moves) {
          const id = str(m.driveId);
          if (id && m.toSlotId === slotId) start(id, date, row.at, row.rowid, 'replace');
        }
        break;
      }
      case 'drive-replaced': {
        const outgoingId = l.drives.find((d) => d.role === 'outgoing')?.driveId;
        const incomingId = l.drives.find((d) => d.role === 'incoming')?.driveId;
        const out = isRecord(p.outgoing) ? p.outgoing : {};
        if (here.has('at') && outgoingId) {
          const kind = str(out.outcome);
          const to = kind === 'moved' ? destination(otherSlot('to'), str(out.toSlotId)) : null;
          const outcome: SlotHistoryOutcome =
            kind === 'retired'
              ? { kind: 'retired', reason: str(out.reason) }
              : kind === 'rma'
                ? { kind: 'rma' }
                : kind === 'moved' && to
                  ? { kind: 'moved', ...to }
                  : { kind: 'spares' };
          end(outgoingId, ev, {
            outcome,
            removedOn: str(out.date),
            installedOn: str(out.installedOn),
            replacedBy: incomingId ? { driveId: incomingId, ...info(incomingId) } : null,
          });
        }
        if (here.has('at') && incomingId) {
          start(incomingId, str(p.installedOn), row.at, row.rowid, 'keep');
        }
        if (here.has('to') && !here.has('at') && outgoingId) {
          // The displaced drive was moved into this bay (it may already be open from the bay's own event).
          start(outgoingId, str(out.date), row.at, row.rowid, 'keep');
        }
        if (here.has('from') && !here.has('at') && incomingId) {
          // The incoming drive came from this bay into an occupied one.
          const to = destination(otherSlot('at'), null);
          end(incomingId, ev, {
            outcome: to ? { kind: 'moved', ...to } : { kind: 'spares' },
            removedOn: str(p.installedOn),
            installedOn: null,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  const occupant = db.select().from(drives).where(eq(drives.slotId, slotId)).get();
  const entries: Finished[] = [...done];
  for (const o of open.values()) {
    entries.push({
      driveId: o.driveId,
      installedOn: o.installedOn,
      installedRecordedAt: o.installedRecordedAt,
      removedOn: null,
      removedRecordedAt: null,
      outcome: occupant?.id === o.driveId ? null : { kind: 'spares' },
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
