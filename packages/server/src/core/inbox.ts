import { eq } from 'drizzle-orm';
import type {
  CreateFromObservationInput,
  Drive,
  ImportRetiredInput,
  InboxResponse,
  LinkObservationInput,
  Observation,
  RetiredCandidate,
} from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { drives } from '../db/schema.js';
import { assignDrive, retireDrive, type AssignDriveResult } from './assignment.js';
import { createDrive } from './drives.js';
import { conflict, invalid, notFound } from './errors.js';
import { recordEvent } from './events.js';
import { findDriveFor, getMatchState, observationKeyOf } from './matching.js';

// The discovery inbox (R9, R22 to R25, R58, R63). Resolving an entry also picks the slot (decision
// under R23) and installs the drive through assignDrive, so installed always means "has a slot" (D7).
// Each action is one transaction: if the assignment fails nothing is created, changed or logged.
// Nested db.transaction calls on drizzle's better-sqlite3 driver become savepoints, so the Step 3
// and Step 7 services are reused as they are.

/** A transaction handle can stand in for the database: its `transaction` opens a savepoint. */
const nested = (tx: unknown): AppDb => tx as AppDb;

/** GET /api/inbox. Read-only: a suggestion is never applied here (R25). */
export function getInbox(db: AppDb): InboxResponse {
  const state = getMatchState(db);
  return {
    entries: state.inbox,
    unidentified: state.unidentified,
    retiredCandidates: state.retiredCandidates.map(toRetiredCandidate),
    count: state.inbox.length,
  };
}

export function listRetiredCandidates(db: AppDb): RetiredCandidate[] {
  return getMatchState(db).retiredCandidates.map(toRetiredCandidate);
}

function toRetiredCandidate(o: Observation): RetiredCandidate {
  return {
    observationKey: observationKeyOf(o) ?? '',
    serial: (o.serial ?? '').trim(),
    model: o.model ?? null,
    capacityBytes: o.capacityBytes ?? null,
    driveType: o.driveType ?? null,
    retirementDate: o.lastReportedAt.slice(0, 10),
    healthHint: o.health,
  };
}

/** The inbox entry for a key, else 404 (no such observation) or 409 (it no longer needs resolving). */
function requireInboxEntry(db: AppDb, key: string) {
  const state = getMatchState(db);
  const wanted = key.trim().toUpperCase();
  const entry = state.inbox.find((e) => e.observationKey === wanted);
  if (entry) return entry;
  const known = [...state.matched.map((m) => m.observation), ...state.retiredCandidates].some(
    (o) => observationKeyOf(o) === wanted,
  );
  if (known) throw conflict(`Observation ${key} is not in the inbox`);
  throw notFound(`No observation with serial ${key}`);
}

type Filled = Partial<Pick<Drive, 'wwn' | 'model' | 'capacityBytes' | 'driveType' | 'formFactor'>>;

/** Fields the observation can supply that the drive lacks (R22). */
function missingFrom(drive: Drive, o: Observation): Filled {
  const filled: Filled = {};
  if (!drive.wwn && o.wwn?.trim()) filled.wwn = o.wwn.trim();
  if (!drive.model && o.model) filled.model = o.model;
  if (drive.capacityBytes === null && o.capacityBytes !== undefined) {
    filled.capacityBytes = o.capacityBytes;
  }
  if (!drive.driveType && o.driveType) filled.driveType = o.driveType;
  if (!drive.formFactor && o.formFactor) filled.formFactor = o.formFactor;
  return filled;
}

const placementOf = (input: LinkObservationInput | CreateFromObservationInput) => ({
  slotId: input.slotId,
  poolId: input.poolId,
  role: input.role,
  occupant: input.occupant,
});

/**
 * Links an inbox observation to an existing spare, fills what the spare lacks, logs drive-linked
 * and installs it into the chosen slot (R22, R23, R25).
 */
export function linkObservation(
  db: AppDb,
  observationKey: string,
  input: LinkObservationInput,
): AssignDriveResult {
  const entry = requireInboxEntry(db, observationKey);
  return db.transaction((tx) => {
    const drive = tx.select().from(drives).where(eq(drives.id, input.driveId)).get();
    if (!drive) throw notFound(`Drive ${input.driveId} not found`);
    if (drive.status !== 'spare') {
      throw conflict(`Drive ${drive.id} is ${drive.status}; only a spare can be linked`);
    }
    const filled = missingFrom(drive, entry.observation);
    const linked = { ...drive, ...filled } as Drive;
    // Once linked, the observation must keep matching this record, or it would stay in the inbox.
    if (
      findDriveFor(
        entry.observation,
        new Map([[linked.serialNormalized, linked]]),
        wwnIndex(linked),
      ) === undefined
    ) {
      throw invalid(
        `Observation ${entry.observationKey} cannot be linked to drive ${drive.serial}: the serials differ and the WWN does not match`,
      );
    }
    if (Object.keys(filled).length > 0) {
      tx.update(drives)
        .set({ ...filled, updatedAt: new Date().toISOString() })
        .where(eq(drives.id, drive.id))
        .run();
    }
    recordEvent(tx, {
      driveId: drive.id,
      type: 'drive-linked',
      payload: { observationSerial: entry.observation.serial ?? null, filled },
    });
    return assignDrive(nested(tx), { driveId: drive.id, ...placementOf(input) });
  });
}

function wwnIndex(drive: Drive): Map<string, Drive> {
  const wwn = drive.wwn?.trim().toLowerCase();
  return new Map(wwn ? [[wwn, drive]] : []);
}

/** Creates a drive record from an inbox observation and installs it into the chosen slot (R22, R23). */
export function createFromObservation(
  db: AppDb,
  observationKey: string,
  input: CreateFromObservationInput,
): AssignDriveResult {
  const entry = requireInboxEntry(db, observationKey);
  const o = entry.observation;
  return db.transaction((tx) => {
    const created = createDrive(
      nested(tx),
      {
        serial: (o.serial ?? '').trim(),
        model: o.model,
        capacityBytes: o.capacityBytes,
        driveType: o.driveType,
        formFactor: o.formFactor,
        condition: input.condition,
        purchaseDate: input.purchaseDate,
        warrantyExpiry: input.warrantyExpiry,
        vendor: input.vendor,
        notes: input.notes,
      },
      { wwn: o.wwn },
    );
    return assignDrive(nested(tx), { driveId: created.id, ...placementOf(input) });
  });
}

/**
 * R63: creates records for decommissioned observations and retires them, all or nothing. Every item
 * carries its own reason (bulk apply is the UI's job). Health is never applied.
 */
export function importRetired(db: AppDb, input: ImportRetiredInput): Drive[] {
  const candidates = new Map(
    getMatchState(db).retiredCandidates.map((o) => [observationKeyOf(o) ?? '', o]),
  );
  const seen = new Set<string>();
  const planned = input.items.map((item) => {
    const key = item.observationKey.trim().toUpperCase();
    if (seen.has(key)) throw invalid(`Observation ${item.observationKey} is listed twice`);
    seen.add(key);
    const observation = candidates.get(key);
    if (!observation) {
      throw notFound(`Observation ${item.observationKey} is not offered for import`);
    }
    return { item, observation };
  });
  return db.transaction((tx) =>
    planned.map(({ item, observation: o }) => {
      const created = createDrive(
        nested(tx),
        {
          serial: (o.serial ?? '').trim(),
          model: o.model,
          capacityBytes: o.capacityBytes,
          driveType: o.driveType,
          formFactor: o.formFactor,
        },
        { wwn: o.wwn },
      );
      return retireDrive(nested(tx), created.id, {
        reason: item.reason,
        date: item.date ?? o.lastReportedAt.slice(0, 10),
        note: item.note,
      });
    }),
  );
}
