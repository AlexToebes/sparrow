import type { Health, SlotFlag, SlotStatus } from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { createRepositories } from '../db/repositories.js';
import { listDrives } from './drives.js';
import { matchObservations } from './matching.js';
import type { DriveDataProvider } from './provider-port.js';

// Stale and missing detection (R10, R27, R28, R47). Pure reads: every flag is computed from the
// drives, the cached snapshot and `now` on each call, and nothing is stored or changed (R10, R27).
// Acting on a flag is always an explicit user action through the assignment service (Step 7).

const HOUR_MS = 3_600_000;

/** R28: the default threshold is 1.5 x the provider's declared update interval. */
export const STALE_INTERVAL_FACTOR = 1.5;

export const defaultStaleAfterHours = (
  provider: Pick<DriveDataProvider, 'expectedUpdateIntervalHours'>,
) => provider.expectedUpdateIntervalHours * STALE_INTERVAL_FACTOR;

export interface SlotStatusOptions {
  now: Date;
  staleAfterHours: number;
  /** The active provider. Only a snapshot tagged with this ID is used (R55). */
  providerId: string;
}

export interface SlotStatusResult {
  /** R47: all tracked drives (or the snapshot itself) are stale. The UI shows one banner. */
  providerStale: boolean;
  lastSuccessAt: string | null;
  /** One entry per installed drive. Empty slots are omitted. */
  slots: SlotStatus[];
}

const unknownSlot = (drive: { id: string; slotId: string | null }): SlotStatus => ({
  slotId: drive.slotId!,
  driveId: drive.id,
  health: 'unknown',
  lastReportedAt: null,
  temperatureC: null,
  detailUrl: null,
  stale: false,
  flag: null,
});

/**
 * Status of every slot that holds an installed drive. Rules:
 * - provider `none`, or no successful snapshot from this provider: every slot is unknown, no flags.
 * - decommissioned observation: flagged `decommissioned` (R10).
 * - stale observation (older than the threshold): flagged `stale` only while another tracked drive
 *   is fresh (R10). The health is still reported, so the UI can show it as "last known".
 * - no observation while the provider has a fresh one: flagged `not-reported` (the drive vanished).
 * - every tracked drive stale, or the last successful poll itself too old: `providerStale`, and no
 *   per-slot flags at all (R47). Per-slot `stale` stays true so the UI can hatch the slots.
 */
export function computeSlotStatus(db: AppDb, opts: SlotStatusOptions): SlotStatusResult {
  const installed = listDrives(db, { status: 'installed' }).filter((d) => d.slotId !== null);
  const snapshot = createRepositories(db).snapshot.get();
  const usable =
    opts.providerId !== 'none' &&
    snapshot !== null &&
    snapshot.providerId === opts.providerId &&
    snapshot.lastSuccessAt !== null;
  if (!usable || snapshot.lastSuccessAt === null) {
    return { providerStale: false, lastSuccessAt: null, slots: installed.map(unknownSlot) };
  }
  const lastSuccessAt = snapshot.lastSuccessAt;

  const thresholdMs = opts.staleAfterHours * HOUR_MS;
  const isStale = (iso: string) => opts.now.getTime() - Date.parse(iso) > thresholdMs;

  const matched = matchObservations(listDrives(db), snapshot.observations).matchedByDriveId;
  const tracked = installed.filter((d) => matched.has(d.id));
  const staleById = new Map(
    tracked.map((d) => [d.id, isStale(matched.get(d.id)!.observation.lastReportedAt)]),
  );
  const providerStale =
    isStale(lastSuccessAt) ||
    (tracked.length > 0 && tracked.every((d) => staleById.get(d.id) === true));
  const anyFreshObservation = snapshot.observations.some((o) => !isStale(o.lastReportedAt));

  const slots = installed.map((drive): SlotStatus => {
    const match = matched.get(drive.id);
    if (!match) {
      const flag: SlotFlag | null =
        !providerStale && anyFreshObservation ? { kind: 'missing', reason: 'not-reported' } : null;
      return { ...unknownSlot(drive), flag };
    }

    const { observation } = match;
    const stale = staleById.get(drive.id) === true;
    let flag: SlotFlag | null = null;
    if (!providerStale) {
      if (observation.state === 'decommissioned') {
        flag = { kind: 'missing', reason: 'decommissioned' };
      } else if (
        stale &&
        tracked.some((other) => other.id !== drive.id && staleById.get(other.id) === false)
      ) {
        flag = { kind: 'missing', reason: 'stale' };
      }
    }
    return {
      slotId: drive.slotId!,
      driveId: drive.id,
      health: observation.health as Health,
      lastReportedAt: observation.lastReportedAt,
      temperatureC: observation.temperatureC ?? null,
      detailUrl: observation.detailUrl ?? null,
      stale,
      flag,
    };
  });

  return { providerStale, lastSuccessAt, slots };
}
