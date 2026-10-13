import { asc, eq } from 'drizzle-orm';
import type {
  Drive,
  DriveType,
  SlotCompatibility,
  SpareCompatibility,
  CompatibilityVerdict,
} from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { getSlot } from '../db/layout-repo.js';
import { drives, installations } from '../db/schema.js';
import type { Reader } from './activities.js';
import { defaultsFor } from './assignment.js';
import { findDrive, listDrives } from './drives.js';
import { notFound } from './errors.js';
import { installationInSlot } from './installations.js';
import { requirePool } from './memberships.js';

// R12 (changed 2026-10-13 at the owner's request): can this spare replace the drive in a bay? Advice
// only, computed on every read, and it never blocks an action. Sparrow does not model vdevs, so a pool
// is treated as ONE vdev: the usable per-disk size is the smallest capacity among the pool's CURRENT
// members (installations with that pool), including the drive being replaced. A spare fits when it has
// the same drive type as the bay's occupant (or, for an empty bay, the previous occupant, R35) and a
// capacity of at least the target size: the pool's usable size, or else the occupant's own capacity.
// Unknown type or capacity on either side gives `unknown`, never `too-small`.

export interface DriveFacts {
  driveType: DriveType | null;
  capacityBytes: number | null;
}

export interface FitTarget {
  driveType: DriveType | null;
  sizeBytes: number | null;
  basis: 'pool' | 'drive';
}

/** Decimal units (D4), the same rounding the web uses: 4000000000000 gives "4 TB". */
export function formatSize(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
  let unit = 0;
  let value = bytes;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const rounded = value >= 100 ? Math.round(value) : Number(value.toPrecision(3));
  return `${rounded} ${units[unit]}`;
}

/** The smallest known capacity among the members (the pool's usable per-disk size), or null if none is known. */
export function usablePoolSize(members: DriveFacts[]): number | null {
  const known = members.flatMap((m) => (m.capacityBytes === null ? [] : [m.capacityBytes]));
  return known.length === 0 ? null : Math.min(...known);
}

/** The one drive type the members with a known type share; null when none is known or they differ. */
export function commonPoolType(members: DriveFacts[]): DriveType | null {
  const types = new Set(members.flatMap((m) => (m.driveType === null ? [] : [m.driveType])));
  return types.size === 1 ? [...types][0]! : null;
}

const verdict = (
  v: CompatibilityVerdict,
  reason: string,
  neededBytes: number | null = null,
): Omit<SpareCompatibility, 'driveId'> => ({ verdict: v, reason, neededBytes });

/** R12: how one spare compares with a target. Pure. A known type mismatch wins over an unknown size. */
export function checkSpare(
  spare: DriveFacts,
  target: FitTarget,
): Omit<SpareCompatibility, 'driveId'> {
  if (spare.driveType && target.driveType && spare.driveType !== target.driveType) {
    return verdict('different-type', `${spare.driveType}, but this bay holds ${target.driveType}`);
  }
  if (spare.driveType === null || target.driveType === null) {
    return verdict('unknown', 'The drive type is not recorded');
  }
  if (spare.capacityBytes === null || target.sizeBytes === null) {
    return verdict('unknown', 'The capacity is not recorded');
  }
  const what = target.basis === 'pool' ? 'the pool needs per disk' : 'the drive in this bay has';
  if (spare.capacityBytes < target.sizeBytes) {
    return verdict(
      'too-small',
      `Smaller than the ${formatSize(target.sizeBytes)} ${what}`,
      target.sizeBytes,
    );
  }
  return verdict('fits', `Same type and at least the ${formatSize(target.sizeBytes)} ${what}`);
}

/** The current members of a pool (installed drives with that pool) as plain facts. */
function poolMembers(db: Reader, poolId: string): DriveFacts[] {
  return db
    .select({ driveType: drives.driveType, capacityBytes: drives.capacityBytes })
    .from(installations)
    .innerJoin(drives, eq(drives.id, installations.driveId))
    .where(eq(installations.poolId, poolId))
    .orderBy(asc(drives.serialNormalized))
    .all();
}

/** R12: the usable size and shared type of one pool, and how many of the spares fit a bay of it. */
export function poolFitSummary(
  db: Reader,
  poolId: string,
  spares: DriveFacts[],
): { smallestMemberBytes: number | null; sparesFit: number } {
  const members = poolMembers(db, poolId);
  const target: FitTarget = {
    driveType: commonPoolType(members),
    sizeBytes: usablePoolSize(members),
    basis: 'pool',
  };
  return {
    smallestMemberBytes: target.sizeBytes,
    sparesFit: spares.filter((s) => checkSpare(s, target).verdict === 'fits').length,
  };
}

/**
 * R12: every spare on the shelf checked against one bay. The target is the drive in the bay, or for an
 * empty bay the last one that was in it (R35); a bay with neither has no target and no verdicts.
 */
export function getSlotCompatibility(appDb: AppDb, slotId: string): SlotCompatibility {
  return appDb.transaction((db) => {
    if (!getSlot(db, slotId)) throw notFound(`Slot ${slotId} not found`);
    const live = installationInSlot(db, slotId);
    const defaults = defaultsFor(db, slotId);
    const occupant: Drive | undefined = defaults.previousDriveId
      ? findDrive(db, defaults.previousDriveId)
      : undefined;
    if (!occupant) return { slotId, target: null, spares: [] };

    const poolId = live ? live.poolId : defaults.poolId;
    let target: FitTarget = {
      driveType: occupant.driveType,
      sizeBytes: occupant.capacityBytes,
      basis: 'drive',
    };
    let poolName: string | null = null;
    if (poolId) {
      const pool = requirePool(db, poolId);
      poolName = pool.name;
      const size = usablePoolSize(poolMembers(db, poolId));
      if (size !== null) target = { ...target, sizeBytes: size, basis: 'pool' };
    }

    return {
      slotId,
      target: {
        driveType: target.driveType,
        sizeBytes: target.sizeBytes,
        basis: target.basis,
        poolName,
        serial: occupant.serial,
      },
      spares: listDrives(db, { status: 'spare' }).map((s) => ({
        driveId: s.id,
        ...checkSpare(s, target),
      })),
    };
  });
}
