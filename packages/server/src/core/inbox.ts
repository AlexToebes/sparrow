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
import type { DbTransaction } from './activities.js';
import {
  assignInto,
  installedOnOf,
  retireInternal,
  retirementDateOf,
  type AssignDriveResult,
} from './assignment.js';
import { recordActivity, type EventInput } from './activities.js';
import { getDrive, insertDrive, listDrives } from './drives.js';
import { conflict, invalid, notFound } from './errors.js';
import { fitObservedText } from './observation-text.js';
import { getMatchState, matchObservations, normalizeWwn, observationKeyOf } from './matching.js';

// The discovery inbox (R9, R22 to R25, R58, R63). Resolving an entry also picks the slot (decision
// under R23) and installs the drive through assignInto, so installed always means "has a slot" (D7).
// Each action is one transaction and ONE activity (`discovered-linked`, `discovered-created` or
// `retired-imported`): if the assignment fails nothing is created, changed or logged.

/** GET /api/inbox. Read-only: a suggestion is never applied here (R25). */
export function getInbox(db: AppDb, providerId: string): InboxResponse {
  const state = getMatchState(db, providerId);
  return {
    entries: state.inbox,
    unidentified: state.unidentified,
    retiredCandidates: state.retiredCandidates.map(toRetiredCandidate),
    count: state.inbox.length,
    matchedDriveIds: [...state.matchedByDriveId.keys()],
  };
}

export function listRetiredCandidates(db: AppDb, providerId: string): RetiredCandidate[] {
  return getMatchState(db, providerId).retiredCandidates.map(toRetiredCandidate);
}

function toRetiredCandidate(o: Observation): RetiredCandidate {
  return {
    observationKey: observationKeyOf(o) ?? '',
    serial: (o.serial ?? '').trim(),
    model: fitObservedText('model', o.model) ?? null,
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
  const wwn = fitObservedText('wwn', o.wwn);
  const model = fitObservedText('model', o.model);
  const formFactor = fitObservedText('formFactor', o.formFactor);
  if (!drive.wwn && wwn) filled.wwn = wwn;
  if (!drive.model && model) filled.model = model;
  if (drive.capacityBytes === null && o.capacityBytes !== undefined) {
    filled.capacityBytes = o.capacityBytes;
  }
  if (!drive.driveType && o.driveType) filled.driveType = o.driveType;
  if (!drive.formFactor && formFactor) filled.formFactor = formFactor;
  return filled;
}

/**
 * createDrive for values that came from an observation, not from a request. If they fail the drive
 * schema (for example an over-long model) that is a server-side data problem, not a bad request,
 * so it surfaces as a plain Error (HTTP 500) instead of a ZodError (HTTP 400).
 */
function createDriveFromObservation(
  tx: DbTransaction,
  input: Record<string, unknown>,
  wwn: string | undefined,
  evs: EventInput[],
): Drive {
  try {
    return insertDrive(tx, input, { wwn }, evs);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new Error(`The observation cannot be turned into a drive record: ${err.message}`, {
        cause: err,
      });
    }
    throw err;
  }
}

const PLACEMENT_FIELDS = ['slotId', 'poolId', 'role', 'occupant', 'installedOn'] as const;

type Placed = CreateFromObservationInput | (LinkObservationInput & { slotId: string });

const placementOf = (input: Placed) => ({
  slotId: input.slotId,
  poolId: input.poolId,
  role: input.role,
  occupant: input.occupant,
  // R68: a drive found in the NAS is already installed; an omitted date means "not recorded".
  installedOn: input.installedOn ?? null,
});

/**
 * Links an inbox observation to an existing drive record (R22, R25): a spare, which is then
 * installed into the chosen slot (R23, placement required), or an installed drive, which keeps its
 * bay, pool, role and date (placement refused, 400). Retired drives and drives that already match
 * an observation are refused (409). Fills what the record lacks and logs ONE discovered-linked
 * activity (drive-linked, plus the install events for a spare).
 */
export function linkObservation(
  db: AppDb,
  providerId: string,
  observationKey: string,
  input: LinkObservationInput,
): AssignDriveResult {
  const entry = requireInboxEntry(db, providerId, observationKey);
  return db.transaction((tx) => {
    const found = tx.select().from(drives).where(eq(drives.id, input.driveId)).get();
    if (!found) throw notFound(`Drive ${input.driveId} not found`);
    const drive = getDrive(tx, found.id);
    if (drive.status === 'retired') {
      throw conflict(`Drive ${drive.serial} is retired; a retired drive cannot be linked`, {
        driveId: drive.id,
      });
    }
    const given = PLACEMENT_FIELDS.filter((f) => input[f] !== undefined);
    if (drive.status === 'installed' && given.length > 0) {
      throw invalid(
        `Drive ${drive.serial} is installed and stays where it is; remove ${given.join(', ')} from the request`,
      );
    }
    if (drive.status === 'spare' && input.slotId === undefined) {
      throw invalid(`Drive ${drive.serial} is a spare; slotId is required to install it`);
    }
    // R2: a record that already matches an observation (serial, then WWN) has live data of its own.
    // The one allowed match is a spare matching THIS observation (the R25 suggestion).
    const current = getMatchState(db, providerId).matchedByDriveId.get(drive.id);
    if (current && observationKeyOf(current.observation) !== entry.observationKey) {
      throw conflict(
        `Drive ${drive.serial} already matches the observation ${current.observation.serial ?? ''}; only a drive without live data can be linked`,
        { driveId: drive.id },
      );
    }
    const filled = missingFrom(drive, entry.observation);
    const linked: Drive = { ...drive, ...filled };
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
    const all = listDrives(tx).map((d) => (d.id === drive.id ? linked : d));
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
    const evs: EventInput[] = [
      {
        type: 'drive-linked',
        driveId: drive.id,
        // Each filled field with what it was, so the link can be undone as well as replayed.
        payload: {
          observationSerial: entry.observation.serial ?? null,
          filled: Object.fromEntries(
            Object.entries(filled).map(([field, to]) => [
              field,
              { from: drive[field as keyof Filled] ?? null, to },
            ]),
          ),
        },
      },
    ];
    if (drive.status === 'installed') {
      // Nothing moves: the activity holds the drive-linked event alone.
      recordActivity(tx, {
        kind: 'discovered-linked',
        occurredOn: installedOnOf(undefined, new Date()),
        events: evs,
      });
      return { drive: getDrive(tx, drive.id) };
    }
    return placeAndRecord(
      tx,
      'discovered-linked',
      drive.id,
      { ...input, slotId: input.slotId! },
      evs,
    );
  });
}

/** Installs the drive (R23) and records the inbox activity with the events so far plus the placement's. */
function placeAndRecord(
  tx: DbTransaction,
  kind: 'discovered-linked' | 'discovered-created',
  driveId: string,
  input: Placed,
  evs: EventInput[],
): AssignDriveResult {
  const placement = placementOf(input);
  const clock = new Date();
  const result = assignInto(tx, { driveId, ...placement }, clock, evs);
  recordActivity(tx, {
    kind,
    occurredOn: installedOnOf(placement.installedOn, clock),
    events: evs,
  });
  return result;
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
    const evs: EventInput[] = [];
    const created = createDriveFromObservation(
      tx,
      {
        serial: (o.serial ?? '').trim(),
        model: fitObservedText('model', o.model),
        capacityBytes: o.capacityBytes,
        driveType: o.driveType,
        formFactor: fitObservedText('formFactor', o.formFactor),
        condition: input.condition,
        purchaseDate: input.purchaseDate,
        warrantyExpiry: input.warrantyExpiry,
        vendor: input.vendor,
        notes: input.notes,
      },
      fitObservedText('wwn', o.wwn),
      evs,
    );
    return placeAndRecord(tx, 'discovered-created', created.id, input, evs);
  });
}

/**
 * R63: creates records for decommissioned observations and retires them, all or nothing (one transaction, one activity per item). Every item
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
  // Retirements on different days did not happen together, so each item is its own `retired-imported`
  // activity (dated with its retirement day); all of them share ONE transaction, all or nothing.
  return db.transaction((tx) =>
    planned.map(({ item, observation: o }) => {
      const evs: EventInput[] = [];
      const created = createDriveFromObservation(
        tx,
        {
          serial: (o.serial ?? '').trim(),
          model: fitObservedText('model', o.model),
          capacityBytes: o.capacityBytes,
          driveType: o.driveType,
          formFactor: fitObservedText('formFactor', o.formFactor),
        },
        fitObservedText('wwn', o.wwn),
        evs,
      );
      // R63: omitted = the last-reported day (the prefill); an explicit null = not recorded (R60).
      const date = retirementDateOf(
        item.date === undefined ? o.lastReportedAt.slice(0, 10) : item.date,
        new Date(),
      );
      const retired = retireInternal(
        tx,
        created.id,
        { reason: item.reason, date, note: item.note ?? null },
        evs,
      );
      recordActivity(tx, { kind: 'retired-imported', occurredOn: date, events: evs });
      return retired;
    }),
  );
}
