import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { layoutSchema } from '@sparrow/shared';
import { recordActivity } from '../src/core/activities.js';
import { buildApp } from '../src/api/app.js';
import { createLayoutService } from '../src/core/layout.js';
import { createOldLayout } from './old-layout.js';
import { DomainError } from '../src/core/errors.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { activitiesOf, countActivities, eventsOfDrive } from './activity-helpers.js';

let opened: OpenedDatabase;
let repo: Repositories;
beforeEach(() => {
  opened = openDatabase(':memory:');
  repo = createRepositories(opened.db);
});
afterEach(() => opened.sqlite.close());

const service = () => createLayoutService(opened.db);

/** One enclosure, one landscape grid of rows x columns with plain slots. */
function makeGrid(rows = 2, columns = 2, name = 'Front') {
  const layout = service();
  const enclosure = layout.createEnclosure({ name: 'NAS' });
  const grid = layout.createGrid(enclosure.id, { name, rows, columns, orientation: 'landscape' });
  return { layout, enclosure, grid };
}

/** Asserts that fn throws a DomainError with the given code. */
function expectCode(fn: () => unknown, code: string) {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(DomainError);
  expect((caught as DomainError).code).toBe(code);
}

function slotsOf(gridId: string) {
  const layout = service().getLayout();
  return layout.enclosures.flatMap((e) => e.grids).find((g) => g.id === gridId)!.slots;
}

/** Puts a drive in a slot the way the assignment service does: an installation plus the event that says so. */
function installDrive(slotId: string, serial = 'SN-1') {
  const drive = repo.drives.create({ serial });
  repo.installations.create({ driveId: drive.id, slotId });
  opened.db.transaction((tx) =>
    recordActivity(tx, {
      kind: 'assigned',
      events: [{ type: 'drive-installed', driveId: drive.id, slotId, payload: { poolRole: null } }],
    }),
  );
  return { drive };
}

describe('R4, R7: grid creation and layout read', () => {
  it('creates rows*columns slots at positions 0..n-1 with null labels', () => {
    const { grid } = makeGrid(2, 4, 'Front bays');
    const slots = slotsOf(grid.id);
    expect(slots.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(slots.every((s) => s.label === null && s.driveId === null)).toBe(true);
  });

  it('GET layout (service) returns enclosures with nested grids and slots in position order', () => {
    const { layout, grid } = makeGrid(1, 3);
    const result = layout.getLayout();
    expect(() => layoutSchema.parse(result)).not.toThrow();
    expect(result.enclosures).toHaveLength(1);
    expect(result.enclosures[0]!.grids[0]!.id).toBe(grid.id);
    expect(result.enclosures[0]!.grids[0]!.slots.map((s) => s.position)).toEqual([0, 1, 2]);
  });
});

describe('R39: renaming and relabeling never orphan an assignment', () => {
  it('keeps slot IDs, the installation and the drive events after rename and relabel', () => {
    const { layout, grid } = makeGrid(1, 2);
    const slot = slotsOf(grid.id)[0]!;
    const { drive } = installDrive(slot.id);
    const eventsBefore = eventsOfDrive(opened.db, drive.id);

    layout.updateGrid(grid.id, { name: 'Renamed bays' });
    layout.updateSlotLabel(slot.id, { label: 'Bay 1' });

    const after = slotsOf(grid.id)[0]!;
    expect(after.id).toBe(slot.id);
    expect(after.label).toBe('Bay 1');
    expect(after.driveId).toBe(drive.id);
    expect(repo.installations.get(drive.id)?.slotId).toBe(slot.id);
    expect(eventsOfDrive(opened.db, drive.id)).toEqual(eventsBefore);
    expect(service().getLayout().enclosures[0]!.grids[0]!.name).toBe('Renamed bays');
  });

  it('renames an enclosure without touching its grids or occupants', () => {
    const { layout, enclosure, grid } = makeGrid(1, 1);
    const slot = slotsOf(grid.id)[0]!;
    const { drive } = installDrive(slot.id);
    layout.renameEnclosure(enclosure.id, { name: 'Backup box' });
    const [renamed] = layout.getLayout().enclosures;
    expect(renamed!.name).toBe('Backup box');
    expect(renamed!.grids[0]!.slots[0]!.driveId).toBe(drive.id);
  });

  it('empty label input clears the label to null', () => {
    const { layout, grid } = makeGrid(1, 1);
    const slot = slotsOf(grid.id)[0]!;
    layout.updateSlotLabel(slot.id, { label: 'Left' });
    expect(layout.updateSlotLabel(slot.id, { label: null }).label).toBeNull();
  });
});

describe('R40: blocked shrink and removal of occupied slots', () => {
  it('rejects shrinking that would drop an occupied slot, naming it, and changes nothing', () => {
    const { layout, grid } = makeGrid(2, 2); // positions 0..3
    const slots = slotsOf(grid.id);
    const occupiedSlot = slots[3]!;
    installDrive(occupiedSlot.id);

    let caught: unknown;
    try {
      layout.updateGrid(grid.id, { rows: 1, columns: 2 }); // would drop positions 2 and 3
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DomainError);
    const err = caught as DomainError;
    expect(err.code).toBe('conflict');
    expect(err.message).toContain('slot 4');
    expect(err.details).toEqual({
      occupied: [
        {
          slotId: occupiedSlot.id,
          gridId: grid.id,
          gridName: 'Front',
          position: 3,
          label: null,
          driveId: expect.any(String),
        },
      ],
    });

    expect(slotsOf(grid.id)).toHaveLength(4);
    expect(service().getLayout().enclosures[0]!.grids[0]!.rows).toBe(2);
  });

  it('allows shrinking when the dropped slots are empty, and removes them', () => {
    const { layout, grid } = makeGrid(2, 2);
    const kept = slotsOf(grid.id)[0]!;
    layout.updateGrid(grid.id, { rows: 1, columns: 2 });
    const after = slotsOf(grid.id);
    expect(after.map((s) => s.position)).toEqual([0, 1]);
    expect(after[0]!.id).toBe(kept.id);
  });

  it('rejects deleting a grid with an occupied slot and deletes it once empty', () => {
    const { layout, grid } = makeGrid(1, 2);
    const { drive } = installDrive(slotsOf(grid.id)[1]!.id);
    expectCode(() => layout.deleteGrid(grid.id), 'conflict');
    expect(repo.installations.get(drive.id)).toBeDefined();

    // The assignment service owns removal; delete the installation directly so the grid can go.
    opened.sqlite.prepare('DELETE FROM installations WHERE drive_id = ?').run(drive.id);
    layout.deleteGrid(grid.id);
    expect(service().getLayout().enclosures[0]!.grids).toHaveLength(0);
  });

  it('rejects deleting an enclosure while any of its slots is occupied', () => {
    const { layout, enclosure, grid } = makeGrid(1, 1);
    installDrive(slotsOf(grid.id)[0]!.id);
    expectCode(() => layout.deleteEnclosure(enclosure.id), 'conflict');
    expect(service().getLayout().enclosures).toHaveLength(1);
  });
});

describe('resizing and orientation', () => {
  it('growing creates slots at the new positions and keeps existing IDs', () => {
    const { layout, grid } = makeGrid(2, 4);
    const before = slotsOf(grid.id);
    layout.updateGrid(grid.id, { columns: 5 });
    const after = slotsOf(grid.id);
    expect(after).toHaveLength(10);
    expect(after.slice(0, 8).map((s) => s.id)).toEqual(before.map((s) => s.id));
    expect(after.slice(8).map((s) => s.position)).toEqual([8, 9]);
  });

  it('orientation change is rendering-only: same slots, same IDs, same drives', () => {
    const { layout, grid } = makeGrid(2, 4);
    const slot = slotsOf(grid.id)[5]!;
    installDrive(slot.id);
    const before = slotsOf(grid.id);

    const updated = layout.updateGrid(grid.id, { orientation: 'portrait' });
    expect(updated.orientation).toBe('portrait');
    expect(slotsOf(grid.id)).toEqual(before);
  });

  it('transposing rows and columns keeps the slot count and IDs', () => {
    const { layout, grid } = makeGrid(2, 4);
    const before = slotsOf(grid.id);
    layout.updateGrid(grid.id, { rows: 4, columns: 2, orientation: 'portrait' });
    expect(slotsOf(grid.id).map((s) => s.id)).toEqual(before.map((s) => s.id));
  });

  it('rejects a grid name that is already used in the same enclosure', () => {
    const { layout, enclosure } = makeGrid(1, 1, 'Front');
    layout.createGrid(enclosure.id, {
      name: 'Back',
      rows: 1,
      columns: 1,
      orientation: 'landscape',
    });
    const back = layout.getLayout().enclosures[0]!.grids[1]!.id;
    expectCode(() => layout.updateGrid(back, { name: 'Front' }), 'conflict');
  });
});

describe('HTTP API (app.inject)', () => {
  it('GET /api/layout returns the nested layout', async () => {
    createOldLayout(opened.db);
    const app = buildApp({ db: opened.db });
    const res = await app.inject({ method: 'GET', url: '/api/layout' });
    expect(res.statusCode).toBe(200);
    const body = layoutSchema.parse(res.json());
    expect(body.enclosures[0]!.grids[0]!.slots).toHaveLength(8);
    expect(body.enclosures[0]!.grids[0]!.slots[0]!.driveId).toBeNull();
    await app.close();
  });

  it('returns 409 with occupied slots when a shrink is blocked', async () => {
    createOldLayout(opened.db);
    const app = buildApp({ db: opened.db });
    const layout = service().getLayout();
    const front = layout.enclosures[0]!.grids[0]!;
    installDrive(front.slots[7]!.id, 'SN-HTTP');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/grids/${front.id}`,
      payload: { rows: 1 },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: { code: string; details: { occupied: unknown[] } } };
    expect(body.error.code).toBe('conflict');
    expect(body.error.details.occupied).toHaveLength(1);
    await app.close();
  });

  it('maps unknown IDs to 404 and invalid bodies to 400', async () => {
    const app = buildApp({ db: opened.db });
    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/slots/nope',
      payload: { label: 'x' },
    });
    expect(missing.statusCode).toBe(404);
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/enclosures',
      payload: { name: '   ' },
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });
});

describe('R75: layout changes are activities with events that belong to no drive', () => {
  /** Oldest first, each with its events. */
  const allActivities = () => activitiesOf(opened.db);
  const allEvents = () => allActivities().flatMap((a) => a.events);

  it('records enclosure, grid and slot changes, one layout-updated activity each, with full details', () => {
    const svc = createLayoutService(opened.db);
    const enc = svc.createEnclosure({ name: 'NAS' });
    svc.renameEnclosure(enc.id, { name: 'Vault' });
    svc.renameEnclosure(enc.id, { name: 'Vault' }); // no-op
    const grid = svc.createGrid(enc.id, {
      name: 'Front',
      rows: 1,
      columns: 2,
      orientation: 'landscape',
    });
    svc.updateGrid(grid.id, { name: 'Bays', rows: 2 });
    svc.updateGrid(grid.id, { name: 'Bays' }); // no-op
    const slot = svc.getLayout().enclosures[0]!.grids[0]!.slots[0]!;
    svc.updateSlotLabel(slot.id, { label: 'A1' });
    svc.updateSlotLabel(slot.id, { label: 'A1' }); // no-op
    svc.deleteGrid(grid.id);
    svc.deleteEnclosure(enc.id);

    const acts = allActivities();
    expect(acts.map((a) => a.kind)).toEqual(Array(7).fill('layout-updated'));
    expect(acts.map((a) => a.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const rows = allEvents();
    expect(rows.map((e) => e.type)).toEqual([
      'enclosure-created',
      'enclosure-renamed',
      'grid-created',
      'grid-updated',
      'slot-relabeled',
      'grid-deleted',
      'enclosure-deleted',
    ]);
    // Layout events involve no drive and no pool; only the relabel is linked to a bay.
    expect(rows.map((e) => e.driveId)).toEqual(Array(7).fill(null));
    expect(rows.map((e) => e.poolId)).toEqual(Array(7).fill(null));
    expect(rows.map((e) => e.slotId)).toEqual([null, null, null, null, slot.id, null, null]);
    expect(rows[1]!.payload).toMatchObject({ enclosureId: enc.id, from: 'NAS', to: 'Vault' });
    expect(rows[3]!.payload).toMatchObject({
      gridId: grid.id,
      changes: { name: { from: 'Front', to: 'Bays' }, rows: { from: 1, to: 2 } },
    });
    // R75: the grid after the change is carried too, so the feed can name it and show both sizes.
    expect(rows[3]!.payload.after).toMatchObject({ name: 'Bays', rows: 2 });
    // Growing adds slots: the new records are part of the change.
    expect((rows[3]!.payload.slotsAdded as unknown[]).length).toBe(2);
    expect(rows[4]!.payload).toEqual({ from: null, to: 'A1' });
    // The event copies the bay's label (as relabeled) and its grid, so history survives a grid delete.
    expect(rows[4]).toMatchObject({
      slotId: slot.id,
      slotLabel: 'A1',
      gridId: grid.id,
      gridName: 'Bays',
    });
    // Created and deleted things carry their whole record, a grid with its slots.
    expect(rows[0]!.payload).toMatchObject({ id: enc.id, name: 'NAS' });
    expect(rows[2]!.payload).toMatchObject({ id: grid.id, name: 'Front', rows: 1, columns: 2 });
    expect((rows[2]!.payload.slots as unknown[]).length).toBe(2);
    expect(rows[5]!.payload).toMatchObject({ id: grid.id, name: 'Bays' });
    expect((rows[5]!.payload.slots as unknown[]).length).toBe(4);
    expect(rows[6]!.payload).toMatchObject({ id: enc.id, name: 'Vault' });
  });

  it('deleting an enclosure logs each grid with its slots, then the enclosure, in one activity', () => {
    const { layout, enclosure, grid } = makeGrid(1, 2);
    const before = countActivities(opened.db);
    layout.deleteEnclosure(enclosure.id);
    const acts = allActivities().slice(before);
    expect(acts).toHaveLength(1);
    expect(acts[0]!.events.map((e) => e.type)).toEqual(['grid-deleted', 'enclosure-deleted']);
    expect(acts[0]!.events[0]!.payload).toMatchObject({ id: grid.id });
  });

  it('a refused change (occupied slot) writes no activity', () => {
    const svc = createLayoutService(opened.db);
    const enc = svc.createEnclosure({ name: 'NAS' });
    const grid = svc.createGrid(enc.id, {
      name: 'Front',
      rows: 1,
      columns: 2,
      orientation: 'landscape',
    });
    const slot = svc.getLayout().enclosures[0]!.grids[0]!.slots[1]!;
    installDrive(slot.id);
    const before = countActivities(opened.db);
    expect(() => svc.updateGrid(grid.id, { columns: 1 })).toThrow(DomainError);
    expect(() => svc.deleteGrid(grid.id)).toThrow(DomainError);
    expect(() => svc.deleteEnclosure(enc.id)).toThrow(DomainError);
    expect(countActivities(opened.db)).toBe(before);
  });
});
