import type { Drive, InboxEntry, Observation } from '@sparrow/shared';
import { normalizeSerial } from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { createRepositories } from '../db/repositories.js';
import { listDrives } from './drives.js';

// Matching of observations to drive records (R2, R9, R22 to R26, R54, R58, R63).
// Everything here is computed on every read from drives plus the cached snapshot. Nothing is stored
// and no provider ID is used: the key is the normalized serial, with the WWN as a fallback only.

export interface Match {
  drive: Drive;
  observation: Observation;
}

export interface MatchResult {
  /** Every observation that matched a record, whatever the statuses involved. */
  matched: Match[];
  /** The same matches by drive id (one observation per drive; the first one wins). */
  matchedByDriveId: Map<string, Match>;
  /**
   * Active observations with a serial that need attention (R9): no record at all, or a record that
   * is only a spare. A spare sitting on the shelf cannot be reporting from inside the NAS, so the
   * observation says "this spare was installed" and the spare is offered as the suggestion (R25).
   */
  inbox: InboxEntry[];
  /** Observations without a serial (R58): informational, never linkable. */
  unidentified: Observation[];
  /** Decommissioned observations with a serial and no record (R63). */
  retiredCandidates: Observation[];
  /** Decommissioned observations that match a record (the R10 case, handled in Step 8). */
  decommissionedMatched: Match[];
}

/** R26: the key used to match and to address an inbox entry. Undefined when there is no serial (R58). */
export function observationKeyOf(observation: Observation): string | undefined {
  const serial = observation.serial?.trim();
  return serial ? normalizeSerial(serial) : undefined;
}

export const normalizeWwn = (wwn: string | null | undefined): string | undefined => {
  const value = wwn?.trim().toLowerCase();
  return value ? value : undefined;
};

/** Active beats decommissioned; otherwise the most recently reported wins. */
function preferred(a: Observation, b: Observation): Observation {
  if (a.state !== b.state) return a.state === 'active' ? a : b;
  return b.lastReportedAt > a.lastReportedAt ? b : a;
}

/** Finds the record for one observation: normalized serial first, WWN only when no serial matches. */
export function findDriveFor(
  observation: Observation,
  bySerial: ReadonlyMap<string, Drive>,
  byWwn: ReadonlyMap<string, Drive | null>,
): Drive | undefined {
  const key = observationKeyOf(observation);
  const bySerialHit = key === undefined ? undefined : bySerial.get(key);
  if (bySerialHit) return bySerialHit;
  const wwn = normalizeWwn(observation.wwn);
  return wwn === undefined ? undefined : (byWwn.get(wwn) ?? undefined);
}

export function matchObservations(
  drives: readonly Drive[],
  observations: readonly Observation[],
): MatchResult {
  const bySerial = new Map<string, Drive>();
  const byWwn = new Map<string, Drive | null>();
  for (const drive of drives) {
    bySerial.set(drive.serialNormalized, drive);
    const wwn = normalizeWwn(drive.wwn);
    // A WWN shared by two records is ambiguous, so it matches neither.
    if (wwn !== undefined) byWwn.set(wwn, byWwn.has(wwn) ? null : drive);
  }

  const unidentified: Observation[] = [];
  const byKey = new Map<string, Observation>();
  for (const observation of observations) {
    const key = observationKeyOf(observation);
    if (key === undefined) {
      unidentified.push(observation);
      continue;
    }
    const existing = byKey.get(key);
    byKey.set(key, existing ? preferred(existing, observation) : observation);
  }

  const result: MatchResult = {
    matched: [],
    matchedByDriveId: new Map(),
    inbox: [],
    unidentified,
    retiredCandidates: [],
    decommissionedMatched: [],
  };

  for (const [key, observation] of [...byKey].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const drive = findDriveFor(observation, bySerial, byWwn);
    if (drive) {
      const match = { drive, observation };
      result.matched.push(match);
      if (!result.matchedByDriveId.has(drive.id)) result.matchedByDriveId.set(drive.id, match);
      if (observation.state === 'decommissioned') result.decommissionedMatched.push(match);
      else if (drive.status === 'spare') {
        result.inbox.push({ observationKey: key, observation, suggestion: drive });
      }
    } else if (observation.state === 'decommissioned') {
      result.retiredCandidates.push(observation);
    } else {
      result.inbox.push({ observationKey: key, observation, suggestion: null });
    }
  }
  return result;
}

/**
 * Reads all drives and the cached snapshot and matches them. No snapshot means no observations, and
 * a snapshot written by a provider other than the active one is ignored (R55).
 */
export function getMatchState(db: AppDb, providerId: string): MatchResult {
  const snapshot = createRepositories(db).snapshot.get();
  const mine = snapshot && snapshot.providerId === providerId ? snapshot : null;
  return matchObservations(listDrives(db), mine?.observations ?? []);
}
