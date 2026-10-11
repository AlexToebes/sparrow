import type {
  Drive,
  Observation,
  Suggestion,
  SuggestionField,
  SuggestionSummaryResponse,
} from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { conflict } from './errors.js';
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

/** GET /api/drives/:id/suggestions. A drive without a matching observation has none. */
export function getDriveSuggestions(db: AppDb, providerId: string, driveId: string): Suggestion[] {
  getDrive(db, driveId); // 404 for an unknown drive
  const match = getMatchState(db, providerId).matchedByDriveId.get(driveId);
  return match ? suggestionsFor(match) : [];
}

/** GET /api/suggestions: per drive, how many suggestions of each kind (drives with none are left out). */
export function getSuggestionSummary(db: AppDb, providerId: string): SuggestionSummaryResponse {
  const byDriveId: SuggestionSummaryResponse['byDriveId'] = {};
  for (const [id, match] of getMatchState(db, providerId).matchedByDriveId) {
    const all = suggestionsFor(match);
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
    const current = match ? suggestionsFor(match) : [];
    const patch: Record<string, string | number> = {};
    for (const field of new Set(fields)) {
      const suggestion = current.find((s) => s.field === field);
      if (!suggestion) throw conflict(`The suggestion for ${field} no longer applies`, { field });
      patch[field] = suggestion.suggested;
    }
    return updateDrive(inner, driveId, patch, { source: 'provider' });
  });
}
