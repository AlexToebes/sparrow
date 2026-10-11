import { eq } from 'drizzle-orm';
import { ZodError } from 'zod';
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
import { getMatchState, matchObservations, normalizeWwn, observationKeyOf } from './matching.js';

// The discovery inbox (R9, R22 to R25, R58, R63). Resolving an entry also picks the slot (decision
// under R23) and installs the drive through assignDrive, so installed always means "has a slot" (D7).
// Each action is one transaction: if the assignment fails nothing is created, changed or logged.
// Nested db.transaction calls on drizzle's better-sqlite3 driver become savepoints, so the Step 3
// and Step 7 services are reused as they are.

/** A transaction handle can stand in for the database: its `transaction` opens a savepoint. */
const nested = (tx: unknown): AppDb => tx as AppDb;

/** GET /api/inbox. Read-only: a suggestion is never applied here (R25). */
export function getInbox(db: AppDb, providerId: string): InboxResponse {
  const state = getMatchState(db, providerId);
  return {
    entries: state.inbox,
    unidentified: state.unidentified,
    retiredCandidates: state.retiredCandidates.map(toRetiredCandidate),
    count: state.inbox.length,
  };
}

export function listRetiredCandidates(db: AppDb, providerId: string): RetiredCandidate[] {
  return getMatchState(db, providerId).retiredCandidates.map(toRetiredCandidate);
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
function requireInboxEntry(db: AppDb, providerId: string, key: string) {
  const state = getMatchState(db, providerId);
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

/**
 * createDrive for values that came from an observation, not from a request. If they fail the drive
 * schema (for example an over-long model) that is a server-side data problem, not a bad request,
 * so it surfaces as a plain Error (HTTP 500) instead of a ZodError (HTTP 400).
 */
function createDriveFromObservation(
  tx: AppDb,
  input: Record<string, unknown>,
  wwn: string | undefined,
): Drive {
  try {
    return createDrive(tx, input, { wwn });
  } catch (err) {
    if (err instanceof ZodError) {
      throw new Error(`The observation cannot be turned into a drive record: ${err.message}`, {
        cause: err,
      });
    }
    throw err;
  }
}

const placementOf = (input: LinkObservationInput | CreateFromObservationInput) => ({
  slotId: input.slotId,
  poolId: input.poolId,
  role: input.role,
  occupant: input.occupant,
  installedOn: input.installedOn,
});

/**
 * Links an inbox observation to an existing spare, fills what the spare lacks, logs drive-linked
 * and installs it into the chosen slot (R22, R23, R25).
 */
export function linkObservation(
  db: AppDb,
  providerId: string,
  observationKey: string,
  input: LinkObservationInput,
): AssignDriveResult {
  const entry = requireInboxEntry(db, providerId, observationKey);
  return db.transaction((tx) => {
    const drive = tx.select().from(drives).where(eq(drives.id, input.driveId)).get();
    if (!drive) throw notFound(`Drive ${input.driveId} not found`);
    if (drive.status !== 'spare') {
      throw conflict(`Drive ${drive.id} is ${drive.status}; only a spare can be linked`);
    }
    const filled = missingFrom(drive, entry.observation);
    const linked = { ...drive, ...filled } as Drive;
    // Never copy a WWN that another record already holds: it would make the WWN ambiguous (R2).
    if (filled.wwn !== undefined) {
      const wanted = normalizeWwn(filled.wwn);
      const holder = tx
        .select()
        .from(drives)
        .all()
        .find((d) => d.id !== drive.id && normalizeWwn(d.wwn) === wanted);
      if (holder) {
        throw conflict(
          `WWN ${filled.wwn} is already held by drive ${holder.serial}; it cannot be copied to ${drive.serial}`,
          { driveId: holder.id },
        );
      }
    }
    // Run the real matching over ALL records with the filled values applied: once linked, the
    // observation must resolve to this very record, or it would stay in the inbox (R22, R26).
    const all = tx
      .select()
      .from(drives)
      .all()
      .map((d) => (d.id === drive.id ? linked : d));
    const after = matchObservations(all, [entry.observation]).matchedByDriveId.get(drive.id);
    if (!after) {
      throw conflict(
        `This drive's serial doesn't match the observation ${entry.observationKey}; it would stay unmatched`,
        { driveId: drive.id },
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

/** Creates a drive record from an inbox observation and installs it into the chosen slot (R22, R23). */
export function createFromObservation(
  db: AppDb,
  providerId: string,
  observationKey: string,
  input: CreateFromObservationInput,
): AssignDriveResult {
  const entry = requireInboxEntry(db, providerId, observationKey);
  const o = entry.observation;
  return db.transaction((tx) => {
    const created = createDriveFromObservation(
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
      o.wwn,
    );
    return assignDrive(nested(tx), { driveId: created.id, ...placementOf(input) });
  });
}

/**
 * R63: creates records for decommissioned observations and retires them, all or nothing. Every item
 * carries its own reason (bulk apply is the UI's job). Health is never applied.
 */
export function importRetired(db: AppDb, providerId: string, input: ImportRetiredInput): Drive[] {
  const candidates = new Map(
    getMatchState(db, providerId).retiredCandidates.map((o) => [observationKeyOf(o) ?? '', o]),
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
      const created = createDriveFromObservation(
        nested(tx),
        {
          serial: (o.serial ?? '').trim(),
          model: o.model,
          capacityBytes: o.capacityBytes,
          driveType: o.driveType,
          formFactor: o.formFactor,
        },
        o.wwn,
      );
      return retireDrive(nested(tx), created.id, {
        reason: item.reason,
        date: item.date ?? o.lastReportedAt.slice(0, 10),
        note: item.note,
      });
    }),
  );
}
