import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { asc } from 'drizzle-orm';
import {
  EXPORT_FORMAT,
  EXPORT_SCHEMA_VERSION,
  MIN_IMPORT_SCHEMA_VERSION,
  exportFileSchema,
  normalizeSerial,
  type ExportData,
  type ExportFile,
} from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import {
  activities,
  appMeta,
  driveConflicts,
  drives,
  enclosures,
  events,
  grids,
  installations,
  pools,
  slots,
} from '../db/schema.js';
import { conflict, invalid } from './errors.js';

// R41, R42, R43, R44: export, import and the automatic backup taken before an import.
// The provider snapshot cache is not user data and is never exported or replaced (R42).

export interface ImportCounts {
  enclosures: number;
  grids: number;
  slots: number;
  drives: number;
  pools: number;
  driveConflicts: number;
  installations: number;
  activities: number;
  events: number;
  appMeta: number;
}

export interface ImportResult {
  /** Where the automatic backup of the pre-import data was written (R44). */
  backupPath: string;
  counts: ImportCounts;
}

export interface ImportOptions {
  /** Directory for the automatic backup, usually `$DATA_DIR/exports`. Created if missing. */
  backupDir: string;
  now?: Date;
}

/** R41: the log in `seq` order, each activity with its events nested in order. */
function exportActivities(db: AppDb): ExportData['activities'] {
  const byActivity = new Map<string, ExportData['activities'][number]['events']>();
  for (const { activityId, ...event } of db
    .select()
    .from(events)
    .orderBy(asc(events.activityId), asc(events.ord))
    .all()) {
    byActivity.set(activityId, [...(byActivity.get(activityId) ?? []), event]);
  }
  return db
    .select()
    .from(activities)
    .orderBy(asc(activities.seq))
    .all()
    .map((a) => ({ ...a, events: byActivity.get(a.id) ?? [] }));
}

/** R41, R42: reads every user table in a stable order. */
export function exportData(db: AppDb, now: Date = new Date()): ExportFile {
  const data: ExportData = {
    enclosures: db
      .select()
      .from(enclosures)
      .orderBy(asc(enclosures.createdAt), asc(enclosures.id))
      .all(),
    grids: db.select().from(grids).orderBy(asc(grids.createdAt), asc(grids.id)).all(),
    slots: db.select().from(slots).orderBy(asc(slots.createdAt), asc(slots.id)).all(),
    drives: db.select().from(drives).orderBy(asc(drives.createdAt), asc(drives.id)).all(),
    installations: db.select().from(installations).orderBy(asc(installations.driveId)).all(),
    pools: db.select().from(pools).orderBy(asc(pools.createdAt), asc(pools.id)).all(),
    driveConflicts: db
      .select()
      .from(driveConflicts)
      .orderBy(asc(driveConflicts.driveAId), asc(driveConflicts.driveBId))
      .all(),
    activities: exportActivities(db),
    appMeta: db.select().from(appMeta).orderBy(asc(appMeta.key)).all(),
  };
  return {
    format: EXPORT_FORMAT,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    data,
  };
}

/** Rejects files that cannot be understood at all, with a message that says why. */
function checkVersion(input: unknown): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid('Not a Sparrow export file: expected a JSON object');
  }
  const file = input as Record<string, unknown>;
  if (file.format !== EXPORT_FORMAT) {
    throw invalid(
      `Not a Sparrow export file: format is ${JSON.stringify(file.format ?? null)}, expected "${EXPORT_FORMAT}"`,
    );
  }
  const version = file.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw invalid('Export file has no valid schemaVersion');
  }
  if (version > EXPORT_SCHEMA_VERSION) {
    throw invalid(
      `This export was made by a newer Sparrow (schema ${version}); this version supports up to ${EXPORT_SCHEMA_VERSION}.`,
    );
  }
  if (version < MIN_IMPORT_SCHEMA_VERSION) {
    throw invalid(
      "This export was made by a pre-release build with an older format (before the activity log) and can't be imported; start fresh.",
    );
  }
}

/**
 * R42, R78: a version 3 file (before drive conflicts) is upgraded in memory to version 4 with no
 * pairs, so old exports keep importing. Anything else is returned unchanged.
 */
function upgradeToCurrent(input: unknown): unknown {
  const file = input as { schemaVersion: number; data?: unknown };
  if (file.schemaVersion !== 3) return input;
  const data =
    typeof file.data === 'object' && file.data !== null && !Array.isArray(file.data)
      ? { driveConflicts: [], ...(file.data as object) }
      : file.data;
  return { ...file, schemaVersion: EXPORT_SCHEMA_VERSION, data };
}

/** Every id is unique per table and every foreign key points at an existing row in the file. */
function checkReferences(data: ExportData): string[] {
  const problems: string[] = [];
  const idSet = (name: string, rows: { id: string }[]) => {
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.id)) problems.push(`${name}: duplicate id ${row.id}`);
      seen.add(row.id);
    }
    return seen;
  };
  const enclosureIds = idSet('enclosures', data.enclosures);
  const gridIds = idSet('grids', data.grids);
  const slotIds = idSet('slots', data.slots);
  const driveIds = idSet('drives', data.drives);
  const poolIds = idSet('pools', data.pools);
  idSet('activities', data.activities);
  idSet(
    'events',
    data.activities.flatMap((a) => a.events),
  );
  const seqs = new Set<number>();
  for (const a of data.activities) {
    if (seqs.has(a.seq)) problems.push(`activities: duplicate seq ${a.seq}`);
    seqs.add(a.seq);
  }

  const check = (name: string, id: string, targets: Set<string>, target: string) => {
    if (!targets.has(id)) problems.push(`${name} references missing ${target} ${id}`);
  };
  for (const g of data.grids) check(`grid ${g.id}`, g.enclosureId, enclosureIds, 'enclosure');
  for (const s of data.slots) check(`slot ${s.id}`, s.gridId, gridIds, 'grid');
  const installedDrives = new Set<string>();
  const occupiedSlots = new Set<string>();
  for (const i of data.installations) {
    check(`installation of drive ${i.driveId}`, i.driveId, driveIds, 'drive');
    check(`installation of drive ${i.driveId}`, i.slotId, slotIds, 'slot');
    if (i.poolId !== null) check(`installation of drive ${i.driveId}`, i.poolId, poolIds, 'pool');
    if (installedDrives.has(i.driveId)) problems.push(`drive ${i.driveId} is installed twice`);
    if (occupiedSlots.has(i.slotId)) problems.push(`slot ${i.slotId} holds two drives`);
    installedDrives.add(i.driveId);
    occupiedSlots.add(i.slotId);
  }
  // A drive link must resolve (drives are never deleted); slot and pool links keep their id even
  // after the slot or pool is gone, so those are not checked against the file.
  for (const a of data.activities) {
    for (const e of a.events) {
      if (e.driveId !== null) check(`event ${e.id}`, e.driveId, driveIds, 'drive');
    }
  }
  // R78: a pair names two different drives of the file, in canonical order, once.
  const pairs = new Set<string>();
  for (const c of data.driveConflicts) {
    const name = `drive conflict ${c.driveAId} / ${c.driveBId}`;
    check(name, c.driveAId, driveIds, 'drive');
    check(name, c.driveBId, driveIds, 'drive');
    if (c.driveAId >= c.driveBId)
      problems.push(`${name}: the drives must be two different ones in order`);
    if (pairs.has(`${c.driveAId}|${c.driveBId}`)) problems.push(`${name}: listed twice`);
    pairs.add(`${c.driveAId}|${c.driveBId}`);
  }
  const metaKeys = new Set<string>();
  for (const m of data.appMeta) {
    if (metaKeys.has(m.key)) problems.push(`appMeta: duplicate key ${m.key}`);
    metaKeys.add(m.key);
  }
  return problems;
}

const isConstraintError = (err: unknown): boolean =>
  err instanceof Error && /^SQLITE_CONSTRAINT/.test((err as { code?: string }).code ?? '');

/**
 * R43, R44: validates an export file, writes an automatic export of the current data, then
 * replaces all data in one transaction. Nothing in the database changes unless every step succeeds.
 */
export function importData(db: AppDb, input: unknown, opts: ImportOptions): ImportResult {
  // 1. Format and version first, so the message is about the file and not about a field.
  checkVersion(input);

  // 2. Full structural validation, then referential integrity, all before touching the DB.
  const parsed = exportFileSchema.safeParse(upgradeToCurrent(input));
  if (!parsed.success) {
    throw invalid('Export file failed validation', parsed.error.issues);
  }
  const problems = checkReferences(parsed.data.data);
  if (problems.length > 0) {
    throw invalid('Export file has broken references; nothing was changed', problems);
  }
  const { data } = parsed.data;

  // 3. Automatic backup of the current data. If it cannot be written, abort without changes.
  const now = opts.now ?? new Date();
  const backupPath = path.join(
    opts.backupDir,
    `sparrow-backup-${now.toISOString().replace(/:/g, '-')}.json`,
  );
  const current = exportData(db, now);
  try {
    mkdirSync(opts.backupDir, { recursive: true });
    writeFileSync(backupPath, `${JSON.stringify(current, null, 2)}\n`, { flag: 'wx' });
  } catch (err) {
    // A domain error so the UI shows the real reason. Only the file name and the system error
    // code are exposed, not the data directory path.
    const code = (err as { code?: string }).code;
    const reason = code ? `${code}` : 'unknown error';
    throw conflict(
      `Could not write the automatic backup (${path.basename(backupPath)}: ${reason}); nothing was imported. Check that the data directory is writable and has free space.`,
      { cause: reason },
    );
  }

  // 4. Replace everything in one transaction. Children are deleted first.
  try {
    db.transaction((tx) => {
      tx.delete(appMeta).run();
      tx.delete(activities).run(); // the events go with their activity (ON DELETE CASCADE)
      tx.delete(installations).run();
      tx.delete(driveConflicts).run();
      tx.delete(drives).run();
      tx.delete(slots).run();
      tx.delete(grids).run();
      tx.delete(pools).run();
      tx.delete(enclosures).run();

      for (const row of data.enclosures) tx.insert(enclosures).values(row).run();
      for (const row of data.grids) tx.insert(grids).values(row).run();
      for (const row of data.slots) tx.insert(slots).values(row).run();
      for (const row of data.pools) tx.insert(pools).values(row).run();
      // F20: the normalized serial is derived, so it is recomputed rather than trusted.
      for (const row of data.drives) {
        tx.insert(drives)
          .values({ ...row, serialNormalized: normalizeSerial(row.serial) })
          .run();
      }
      for (const row of data.driveConflicts) tx.insert(driveConflicts).values(row).run();
      for (const row of data.installations) tx.insert(installations).values(row).run();
      for (const { events: items, ...activity } of data.activities) {
        tx.insert(activities).values(activity).run(); // seq is preserved
        for (const event of items)
          tx.insert(events)
            .values({ ...event, activityId: activity.id })
            .run();
      }
      for (const row of data.appMeta) tx.insert(appMeta).values(row).run();
    });
  } catch (err) {
    if (isConstraintError(err)) {
      const message = err instanceof Error ? err.message : String(err);
      throw invalid(
        `The database rejected the import and rolled it back; nothing was changed: ${message}`,
      );
    }
    throw err;
  }

  return {
    backupPath,
    counts: {
      enclosures: data.enclosures.length,
      grids: data.grids.length,
      slots: data.slots.length,
      drives: data.drives.length,
      pools: data.pools.length,
      driveConflicts: data.driveConflicts.length,
      installations: data.installations.length,
      activities: data.activities.length,
      events: data.activities.reduce((n, a) => n + a.events.length, 0),
      appMeta: data.appMeta.length,
    },
  };
}
