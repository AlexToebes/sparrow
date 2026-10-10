import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import * as drivesModule from '../src/core/drives.js';
import { createDrive, getDrive, listDrives, updateDrive } from '../src/core/drives.js';
import { listDriveEvents } from '../src/core/events.js';
import { DomainError } from '../src/core/errors.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import { drives, events } from '../src/db/schema.js';

let opened: OpenedDatabase;
beforeEach(() => {
  opened = openDatabase(':memory:');
});
afterEach(() => opened.sqlite.close());

const db = () => opened.db;
const eventCount = () => opened.db.select().from(events).all().length;
const driveCount = () => opened.db.select().from(drives).all().length;

/** Returns the error a call throws, so tests can assert on code and message. */
function thrown(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (err) {
    if (err instanceof DomainError) return err;
    throw err;
  }
  throw new Error('expected the call to throw a DomainError');
}

describe('spare creation (R3, R11, R21)', () => {
  it('R21: creates a spare with only a serial and no provider data', () => {
    const d = createDrive(db(), { serial: 'WD-123' });
    expect(d.status).toBe('spare');
    expect(d.slotId).toBeNull();
    expect(d.serial).toBe('WD-123');
    expect(d.serialNormalized).toBe('WD-123');
    expect(d.model).toBeNull();
    expect(d.capacityBytes).toBeNull();
    expect(getDrive(db(), d.id)).toEqual(d);
  });

  it('R11: stores all R11 fields when given, with capacity as integer bytes', () => {
    const d = createDrive(db(), {
      serial: 'ST-1',
      model: 'IronWolf',
      capacityBytes: 4_000_787_030_016,
      driveType: 'HDD',
      formFactor: '3.5',
      storageLocation: 'Shelf A',
      condition: 'tested',
      lastTestDate: '2026-01-02',
      purchaseDate: '2025-12-01',
      warrantyExpiry: '2030-12-01',
      vendor: 'Seagate',
      notes: 'bought in a pair',
    });
    expect(d).toMatchObject({
      model: 'IronWolf',
      capacityBytes: 4_000_787_030_016,
      driveType: 'HDD',
      condition: 'tested',
      lastTestDate: '2026-01-02',
      notes: 'bought in a pair',
    });
  });

  it('R11: rejects fractional or negative capacity', () => {
    expect(() => createDrive(db(), { serial: 'X', capacityBytes: 1.5 })).toThrow(ZodError);
    expect(() => createDrive(db(), { serial: 'X', capacityBytes: -1 })).toThrow(ZodError);
    expect(driveCount()).toBe(0);
  });

  it('R14: creation writes one drive-created event whose payload holds the initial fields', () => {
    const d = createDrive(db(), { serial: ' abc ', model: 'M' });
    const evs = listDriveEvents(db(), d.id);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ driveId: d.id, type: 'drive-created' });
    expect(evs[0]!.payload).toMatchObject({ serial: 'abc', model: 'M', capacityBytes: null });
  });

  it('R13: status, slot and retirement fields cannot be set on create', () => {
    expect(() => createDrive(db(), { serial: 'A', status: 'installed' })).toThrow(ZodError);
    expect(() => createDrive(db(), { serial: 'A', slotId: 'x' })).toThrow(ZodError);
    expect(() => createDrive(db(), { serial: 'A', retirementReason: 'failed' })).toThrow(ZodError);
    expect(driveCount()).toBe(0);
    expect(eventCount()).toBe(0);
  });

  it('R11: serial is required and trimmed', () => {
    expect(() => createDrive(db(), {})).toThrow(ZodError);
    expect(() => createDrive(db(), { serial: '   ' })).toThrow(ZodError);
  });
});

describe('duplicate serials (D6, R26)', () => {
  it('D6/R26: rejects a duplicate serial after normalization with a conflict naming the existing drive', () => {
    const first = createDrive(db(), { serial: 'ABC-1' });
    let caught: unknown;
    try {
      createDrive(db(), { serial: '  abc-1 ' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DomainError);
    const err = caught as DomainError;
    expect(err.code).toBe('conflict');
    expect(err.message).toContain('ABC-1');
    expect(err.message).toContain(first.id);
    expect(driveCount()).toBe(1);
    expect(eventCount()).toBe(1);
  });

  it('D6: the unique index still backs the explicit check', () => {
    createDrive(db(), { serial: 'ZZ' });
    expect(() =>
      opened.db
        .insert(drives)
        .values({
          id: 'raw',
          serial: 'zz',
          serialNormalized: 'ZZ',
          status: 'spare',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        })
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it("D6/R26: updating a drive to another drive's serial (after normalization) is a conflict and changes nothing", () => {
    const a = createDrive(db(), { serial: 'A1', model: 'orig' });
    const b = createDrive(db(), { serial: 'B2', model: 'orig' });
    expect(thrown(() => updateDrive(db(), b.id, { serial: ' a1 ', model: 'changed' })).code).toBe(
      'conflict',
    );
    expect(getDrive(db(), b.id)).toMatchObject({ serial: 'B2', model: 'orig' });
    expect(getDrive(db(), a.id).serial).toBe('A1');
    expect(listDriveEvents(db(), b.id).map((e) => e.type)).toEqual(['drive-created']);
  });

  it("D6: re-submitting a drive's own serial in a different case is allowed", () => {
    const d = createDrive(db(), { serial: 'Case1' });
    const updated = updateDrive(db(), d.id, { serial: 'CASE1' });
    expect(updated).toMatchObject({ serial: 'CASE1', serialNormalized: 'CASE1' });
  });
});

describe('editing (R3, R14)', () => {
  it('R14: edits write one drive-updated event listing only the fields that changed, as from/to', () => {
    const d = createDrive(db(), { serial: 'E1', model: 'old', notes: 'keep' });
    const updated = updateDrive(db(), d.id, { model: 'new', vendor: 'Acme', notes: 'keep' });
    expect(updated).toMatchObject({ model: 'new', vendor: 'Acme', notes: 'keep' });

    const latest = listDriveEvents(db(), d.id)[0]!;
    expect(latest.type).toBe('drive-updated');
    expect(latest.payload).toEqual({
      changes: {
        model: { from: 'old', to: 'new' },
        vendor: { from: null, to: 'Acme' },
      },
    });
  });

  it('R14: a no-op patch writes no event and leaves updatedAt alone', () => {
    const d = createDrive(db(), { serial: 'N1', model: 'same' });
    const before = eventCount();
    const same = updateDrive(db(), d.id, { model: 'same', serial: 'N1' });
    expect(same).toEqual(d);
    expect(updateDrive(db(), d.id, {})).toEqual(d);
    expect(eventCount()).toBe(before);
  });

  it('R14: clearing a field to null is an edit and is logged', () => {
    const d = createDrive(db(), { serial: 'C1', model: 'gone' });
    updateDrive(db(), d.id, { model: null });
    expect(getDrive(db(), d.id).model).toBeNull();
    expect(listDriveEvents(db(), d.id)[0]!.payload).toEqual({
      changes: { model: { from: 'gone', to: null } },
    });
  });

  it('R14: a serial edit logs the serial change with the trimmed value', () => {
    const d = createDrive(db(), { serial: 'S-OLD' });
    updateDrive(db(), d.id, { serial: '  s-new ' });
    expect(getDrive(db(), d.id)).toMatchObject({ serial: 's-new', serialNormalized: 'S-NEW' });
    expect(listDriveEvents(db(), d.id)[0]!.payload).toEqual({
      changes: { serial: { from: 'S-OLD', to: 's-new' } },
    });
  });

  it('R14: a failing update writes no event and leaves the drive unchanged (same transaction)', () => {
    const d = createDrive(db(), { serial: 'T1', model: 'before' });
    // Make the event insert fail after the drive row has been updated inside the same transaction.
    opened.sqlite.exec(
      "CREATE TRIGGER fail_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'event write failed'); END;",
    );
    const eventsBefore = eventCount();
    expect(() => updateDrive(db(), d.id, { model: 'after' })).toThrow(/event write failed/);
    expect(getDrive(db(), d.id)).toMatchObject({ model: 'before' });
    expect(eventCount()).toBe(eventsBefore);
  });

  it('R14: a failing create writes no drive row', () => {
    opened.sqlite.exec(
      "CREATE TRIGGER fail_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'event write failed'); END;",
    );
    expect(() => createDrive(db(), { serial: 'NOPE' })).toThrow(/event write failed/);
    expect(driveCount()).toBe(0);
  });

  it('R13: status, slot and retirement fields are not editable (rejected, not ignored)', () => {
    const d = createDrive(db(), { serial: 'L1' });
    const before = eventCount();
    expect(() => updateDrive(db(), d.id, { status: 'retired' })).toThrow(ZodError);
    expect(() => updateDrive(db(), d.id, { slotId: 'slot-1' })).toThrow(ZodError);
    expect(() => updateDrive(db(), d.id, { retirementReason: 'failed' })).toThrow(ZodError);
    expect(() => updateDrive(db(), d.id, { replacedByDriveId: d.id })).toThrow(ZodError);
    expect(() => updateDrive(db(), d.id, { id: 'other' })).toThrow(ZodError);
    expect(getDrive(db(), d.id).status).toBe('spare');
    expect(eventCount()).toBe(before);
  });

  it('R11: edit of a missing drive is not-found', () => {
    expect(thrown(() => updateDrive(db(), 'missing', { model: 'x' })).code).toBe('not-found');
  });
});

describe('WWN edit (R2, R14)', () => {
  it('R2: sets, trims, changes and clears the WWN, logging each change in drive-updated', () => {
    const d = createDrive(db(), { serial: 'W1' });
    expect(updateDrive(db(), d.id, { wwn: '  0xAbC  ' }).wwn).toBe('0xAbC');
    const changed = updateDrive(db(), d.id, { wwn: '0xdef' });
    expect(changed.wwn).toBe('0xdef');
    expect(updateDrive(db(), d.id, { wwn: null }).wwn).toBeNull();
    const changes = listDriveEvents(db(), d.id)
      .filter((e) => e.type === 'drive-updated')
      .map((e) => e.payload.changes);
    expect(changes).toEqual([
      { wwn: { from: '0xdef', to: null } },
      { wwn: { from: '0xAbC', to: '0xdef' } },
      { wwn: { from: null, to: '0xAbC' } },
    ]);
    const before = eventCount();
    updateDrive(db(), d.id, { wwn: null }); // already null: no-op
    expect(eventCount()).toBe(before);
  });

  it('R2: rejects a WWN another record holds, case-insensitively, changing nothing', () => {
    createDrive(db(), { serial: 'W1' }, { wwn: '0xABC' });
    const d = createDrive(db(), { serial: 'W2' });
    const before = eventCount();
    expect(thrown(() => updateDrive(db(), d.id, { wwn: ' 0xabc ' })).code).toBe('conflict');
    expect(getDrive(db(), d.id).wwn).toBeNull();
    expect(eventCount()).toBe(before);
  });

  it('R2: an empty WWN string is rejected (use null to clear)', () => {
    const d = createDrive(db(), { serial: 'W3' });
    expect(() => updateDrive(db(), d.id, { wwn: '   ' })).toThrow(ZodError);
  });
});

describe('text length caps (R11)', () => {
  it('R11: rejects over-long serial, model, vendor, formFactor, storageLocation and notes', () => {
    const long = (n: number) => 'x'.repeat(n);
    expect(() => createDrive(db(), { serial: long(101) })).toThrow(ZodError);
    expect(createDrive(db(), { serial: long(100) }).serial).toHaveLength(100);
    for (const field of ['model', 'vendor', 'formFactor', 'storageLocation']) {
      expect(() => createDrive(db(), { serial: `C-${field}`, [field]: long(201) })).toThrow(
        ZodError,
      );
    }
    expect(() => createDrive(db(), { serial: 'C-notes', notes: long(5001) })).toThrow(ZodError);
    expect(
      createDrive(db(), { serial: 'C-ok', notes: long(5000), model: long(200) }).notes,
    ).toHaveLength(5000);
    const d = createDrive(db(), { serial: 'C-edit' });
    expect(() => updateDrive(db(), d.id, { notes: long(5001) })).toThrow(ZodError);
  });
});

describe('queries (R3)', () => {
  it('R3: lists drives and filters by status', () => {
    const a = createDrive(db(), { serial: 'Q-A' });
    createDrive(db(), { serial: 'Q-B' });
    expect(listDrives(db())).toHaveLength(2);
    expect(listDrives(db(), { status: 'spare' })).toHaveLength(2);
    expect(listDrives(db(), { status: 'installed' })).toEqual([]);
    expect(listDrives(db(), { status: 'spare' }).map((d) => d.id)).toContain(a.id);
  });

  it("R14: lists a drive's events newest first", () => {
    const d = createDrive(db(), { serial: 'O1', model: 'a' });
    updateDrive(db(), d.id, { model: 'b' });
    updateDrive(db(), d.id, { model: 'c' });
    const types = listDriveEvents(db(), d.id).map((e) => e.type);
    expect(types).toEqual(['drive-updated', 'drive-updated', 'drive-created']);
    expect(listDriveEvents(db(), d.id)[0]!.payload).toEqual({
      changes: { model: { from: 'b', to: 'c' } },
    });
  });

  it('R14: events are scoped to their drive', () => {
    const a = createDrive(db(), { serial: 'SC-A' });
    const b = createDrive(db(), { serial: 'SC-B' });
    updateDrive(db(), a.id, { model: 'x' });
    expect(listDriveEvents(db(), a.id)).toHaveLength(2);
    expect(listDriveEvents(db(), b.id)).toHaveLength(1);
  });

  it('R11: get of an unknown drive is not-found', () => {
    expect(thrown(() => getDrive(db(), 'nope')).code).toBe('not-found');
  });
});

describe('no hard delete (D5)', () => {
  it('D5: the drive service exposes no delete or remove function', () => {
    const names = Object.keys(drivesModule);
    expect(names.filter((n) => /delete|remove|destroy|purge/i.test(n))).toEqual([]);
  });

  it('D5: a drive that was created remains after every edit, and no drive row disappears', () => {
    const d = createDrive(db(), { serial: 'KEEP-ME' });
    updateDrive(db(), d.id, { model: 'x' });
    expect(getDrive(db(), d.id).serial).toBe('KEEP-ME');
    expect(driveCount()).toBe(1);
  });
});
