import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import {
  EXPORT_FORMAT,
  EXPORT_SCHEMA_VERSION,
  exportFileSchema,
  type ExportData,
  type ExportFile,
} from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import {
  appMeta,
  drives,
  enclosures,
  events,
  grids,
  memberships,
  pools,
  slots,
} from '../db/schema.js';
import { invalid } from './errors.js';

// R41, R42, R43, R44: export, import and the automatic backup taken before an import.
// The provider snapshot cache is not user data and is never exported or replaced (R42).

export interface ImportCounts {
  enclosures: number;
  grids: number;
  slots: number;
  drives: number;
  pools: number;
  memberships: number;
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
    pools: db.select().from(pools).orderBy(asc(pools.createdAt), asc(pools.id)).all(),
    memberships: db
      .select()
      .from(memberships)
      .orderBy(asc(memberships.createdAt), asc(memberships.id))
      .all(),
    events: db.select().from(events).orderBy(asc(events.at), asc(events.id)).all(),
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
  if (version < EXPORT_SCHEMA_VERSION) {
    throw invalid(
      `Export schema ${version} is not supported by this version of Sparrow (supports ${EXPORT_SCHEMA_VERSION}).`,
    );
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * R68: schema-1 files written before installed_on existed have no `installedOn` on their drives.
 * Such a file cannot say when anything was installed, and the date of an event is when it was
 * recorded, not an installation date, so those drives become "not recorded" (null). Drives that
 * carry the key (even as null) are left alone, so the file is otherwise validated as written.
 */
function backfillInstalledOn(input: unknown): unknown {
  if (!isRecord(input) || !isRecord(input.data)) return input;
  const { drives: driveRows } = input.data;
  if (!Array.isArray(driveRows)) return input;
  const upgraded = driveRows.map((d) =>
    !isRecord(d) || 'installedOn' in d ? d : { ...d, installedOn: null },
  );
  return { ...input, data: { ...input.data, drives: upgraded } };
}

/** R41, R42: export files written before expectedMembers existed import with it set to null. */
function backfillPoolExpectedMembers(input: unknown): unknown {
  if (!isRecord(input) || !isRecord(input.data)) return input;
  const { pools: poolRows } = input.data;
  if (!Array.isArray(poolRows)) return input;
  const upgraded = poolRows.map((p) =>
    !isRecord(p) || 'expectedMembers' in p ? p : { ...p, expectedMembers: null },
  );
  return { ...input, data: { ...input.data, pools: upgraded } };
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
  idSet('memberships', data.memberships);
  idSet('events', data.events);

  const check = (name: string, id: string, targets: Set<string>, target: string) => {
    if (!targets.has(id)) problems.push(`${name} references missing ${target} ${id}`);
  };
  for (const g of data.grids) check(`grid ${g.id}`, g.enclosureId, enclosureIds, 'enclosure');
  for (const s of data.slots) check(`slot ${s.id}`, s.gridId, gridIds, 'grid');
  for (const d of data.drives) {
    if (d.slotId !== null) check(`drive ${d.id}`, d.slotId, slotIds, 'slot');
    if (d.replacedByDriveId !== null) {
      check(`drive ${d.id}`, d.replacedByDriveId, driveIds, 'drive (replacedBy)');
    }
  }
  for (const m of data.memberships) {
    check(`membership ${m.id}`, m.driveId, driveIds, 'drive');
    check(`membership ${m.id}`, m.poolId, poolIds, 'pool');
  }
  for (const e of data.events) {
    if (e.driveId !== null) check(`event ${e.id}`, e.driveId, driveIds, 'drive');
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
  const parsed = exportFileSchema.safeParse(
    backfillPoolExpectedMembers(backfillInstalledOn(input)),
  );
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
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not write the automatic backup to ${backupPath}; import aborted: ${reason}`,
      { cause: err },
    );
  }

  // 4. Replace everything in one transaction. Children are deleted first. The drive self-reference
  //    is cleared before drives are deleted, and inserted drives get it set in a second pass.
  try {
    db.transaction((tx) => {
      tx.delete(appMeta).run();
      tx.delete(events).run();
      tx.delete(memberships).run();
      tx.update(drives).set({ replacedByDriveId: null }).run();
      tx.delete(drives).run();
      tx.delete(slots).run();
      tx.delete(grids).run();
      tx.delete(pools).run();
      tx.delete(enclosures).run();

      for (const row of data.enclosures) tx.insert(enclosures).values(row).run();
      for (const row of data.grids) tx.insert(grids).values(row).run();
      for (const row of data.slots) tx.insert(slots).values(row).run();
      for (const row of data.pools) tx.insert(pools).values(row).run();
      for (const row of data.drives) {
        tx.insert(drives)
          .values({ ...row, replacedByDriveId: null })
          .run();
      }
      for (const row of data.drives) {
        if (row.replacedByDriveId !== null) {
          tx.update(drives)
            .set({ replacedByDriveId: row.replacedByDriveId })
            .where(eq(drives.id, row.id))
            .run();
        }
      }
      for (const row of data.memberships) tx.insert(memberships).values(row).run();
      for (const row of data.events) tx.insert(events).values(row).run();
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
      memberships: data.memberships.length,
      events: data.events.length,
      appMeta: data.appMeta.length,
    },
  };
}
