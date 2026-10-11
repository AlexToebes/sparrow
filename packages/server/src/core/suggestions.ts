import type {
  Drive,
  Observation,
  Suggestion,
  SuggestionField,
  SuggestionSummaryResponse,
} from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { conflict } from './errors.js';
import { listDriveEvents, recordEvent } from './events.js';
import { getDrive, updateDrive } from './drives.js';
import { getMatchState, type Match } from './matching.js';

// Suggested updates (R72): what a matched observation could add to, or disagrees about in, a drive
// record. Computed on every read from the record and the cached snapshot (R54); nothing is stored
// and nothing is applied until the owner confirms (R10 spirit: flag, never auto-change).

const FIELDS: readonly SuggestionField[] = [
  'model',
  'capacityBytes',
  'driveType',
  'formFactor',
  'wwn',
];

const text = (v: string | null | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

/** The observation's value for a field, trimmed; undefined when it reports none. */
function observed(o: Observation, field: SuggestionField): string | number | undefined {
  switch (field) {
    case 'capacityBytes':
      return o.capacityBytes;
    case 'driveType':
      return o.driveType;
    default:
      return text(o[field]);
  }
}

function recorded(d: Drive, field: SuggestionField): string | number | null {
  const v = d[field];
  return typeof v === 'string' ? (text(v) ?? null) : v;
}

/** Model, WWN and form factor compare trimmed and case-insensitively; capacity and type exactly. */
const same = (field: SuggestionField, a: string | number, b: string | number): boolean =>
  typeof a === 'string' && typeof b === 'string' && field !== 'driveType'
    ? a.trim().toLowerCase() === b.trim().toLowerCase()
    : a === b;

export function suggestionsFor({ drive, observation }: Match): Suggestion[] {
  const out: Suggestion[] = [];
  for (const field of FIELDS) {
    const suggested = observed(observation, field);
    if (suggested === undefined) continue;
    const current = recorded(drive, field);
    if (current === null) out.push({ field, kind: 'fill', current: null, suggested });
    else if (!same(field, current, suggested)) {
      out.push({ field, kind: 'differs', current, suggested });
    }
  }
  return out;
}

/**
 * The latest `suggestion-dismissed` value per field (R72). Events come newest first, so the first
 * one seen for a field wins; a null value means the owner restored the suggestion.
 */
function dismissedValues(db: AppDb, driveId: string): Map<SuggestionField, string | number> {
  const latest = new Map<SuggestionField, string | number | null>();
  for (const e of listDriveEvents(db, driveId)) {
    if (e.type !== 'suggestion-dismissed') continue;
    const field = e.payload.field as SuggestionField;
    if (latest.has(field)) continue;
    const v = e.payload.value;
    latest.set(field, typeof v === 'string' || typeof v === 'number' ? v : null);
  }
  const out = new Map<SuggestionField, string | number>();
  for (const [f, v] of latest) if (v !== null) out.set(f, v);
  return out;
}

/** Splits a match's suggestions into shown ones and ones hidden by a dismissal of the same value. */
function split(db: AppDb, match: Match): { active: Suggestion[]; dismissed: Suggestion[] } {
  const all = suggestionsFor(match);
  if (all.length === 0) return { active: [], dismissed: [] };
  const hidden = dismissedValues(db, match.drive.id);
  const active: Suggestion[] = [];
  const dismissed: Suggestion[] = [];
  for (const s of all) {
    const d = hidden.get(s.field);
    (d !== undefined && same(s.field, d, s.suggested) ? dismissed : active).push(s);
  }
  return { active, dismissed };
}

/** GET /api/drives/:id/suggestions. A drive without a matching observation has none. */
export function getDriveSuggestions(db: AppDb, providerId: string, driveId: string): Suggestion[] {
  return getDriveSuggestionLists(db, providerId, driveId).active;
}

/** The shown suggestions and the dismissed ones (R72). */
export function getDriveSuggestionLists(
  db: AppDb,
  providerId: string,
  driveId: string,
): { active: Suggestion[]; dismissed: Suggestion[] } {
  getDrive(db, driveId); // 404 for an unknown drive
  const match = getMatchState(db, providerId).matchedByDriveId.get(driveId);
  return match ? split(db, match) : { active: [], dismissed: [] };
}

/** GET /api/suggestions: per drive, how many suggestions of each kind (drives with none are left out). */
export function getSuggestionSummary(db: AppDb, providerId: string): SuggestionSummaryResponse {
  const byDriveId: SuggestionSummaryResponse['byDriveId'] = {};
  for (const [id, match] of getMatchState(db, providerId).matchedByDriveId) {
    const all = split(db, match).active; // dismissed ones do not count
    if (all.length === 0) continue;
    const fill = all.filter((s) => s.kind === 'fill');
    byDriveId[id] = {
      fill: fill.length,
      differs: all.length - fill.length,
      fillFields: fill.map((s) => s.field),
    };
  }
  return { byDriveId };
}

/**
 * POST /api/drives/:id/suggestions/dismiss. Writes one `suggestion-dismissed` event per field,
 * carrying the suggested value, so the suggestion stays hidden until the provider reports a
 * different value. A field that is not currently shown fails the whole call (409, nothing written).
 */
export function dismissSuggestions(
  db: AppDb,
  providerId: string,
  driveId: string,
  fields: readonly SuggestionField[],
): void {
  getDrive(db, driveId);
  db.transaction((tx) => {
    const inner = tx as unknown as AppDb;
    const match = getMatchState(inner, providerId).matchedByDriveId.get(driveId);
    const active = match ? split(inner, match).active : [];
    const picked = [...new Set(fields)].map((field) => {
      const s = active.find((x) => x.field === field);
      if (!s) throw conflict(`The suggestion for ${field} no longer applies`, { field });
      return s;
    });
    for (const s of picked) {
      recordEvent(tx, {
        driveId,
        type: 'suggestion-dismissed',
        payload: { field: s.field, value: s.suggested },
      });
    }
  });
}

/**
 * POST /api/drives/:id/suggestions/undismiss. Writes a `suggestion-dismissed` event with
 * `value: null` ("restored") per field; the latest event per field decides. A field that is not
 * currently dismissed fails the whole call (409).
 */
export function undismissSuggestions(
  db: AppDb,
  providerId: string,
  driveId: string,
  fields: readonly SuggestionField[],
): void {
  getDrive(db, driveId);
  db.transaction((tx) => {
    const inner = tx as unknown as AppDb;
    const match = getMatchState(inner, providerId).matchedByDriveId.get(driveId);
    const dismissed = match ? split(inner, match).dismissed : [];
    const picked = [...new Set(fields)].map((field) => {
      if (!dismissed.some((x) => x.field === field)) {
        throw conflict(`The suggestion for ${field} is not dismissed`, { field });
      }
      return field;
    });
    for (const field of picked) {
      recordEvent(tx, { driveId, type: 'suggestion-dismissed', payload: { field, value: null } });
    }
  });
}

/**
 * POST /api/drives/:id/suggestions/apply. Applies the CURRENT suggested value of each field in one
 * transaction through updateDrive, which writes the single drive-updated event (R14) tagged
 * `source: 'provider'`. A field that is no longer suggested fails the whole call with a conflict.
 */
export function applySuggestions(
  db: AppDb,
  providerId: string,
  driveId: string,
  fields: readonly SuggestionField[],
): Drive {
  getDrive(db, driveId);
  return db.transaction((tx) => {
    const inner = tx as unknown as AppDb; // a transaction handle opens a savepoint, like inbox.ts
    const match = getMatchState(inner, providerId).matchedByDriveId.get(driveId);
    const current = match ? split(inner, match).active : [];
    const patch: Record<string, string | number> = {};
    for (const field of new Set(fields)) {
      const suggestion = current.find((s) => s.field === field);
      if (!suggestion) throw conflict(`The suggestion for ${field} no longer applies`, { field });
      patch[field] = suggestion.suggested;
    }
    return updateDrive(inner, driveId, patch, { source: 'provider' });
  });
}
