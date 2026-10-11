import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { layoutSchema } from '@sparrow/shared';
import { buildApp } from '../src/api/app.js';
import { createLayoutService, seedInitialLayout } from '../src/core/layout.js';
import { DomainError } from '../src/core/errors.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';

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

/** Puts a drive in a slot the way Step 3/7 will, written straight to the DB. */
function installDrive(slotId: string, serial = 'SN-1') {
  const drive = repo.drives.create({ serial, status: 'installed', slotId });
  const event = repo.events.create({
    driveId: drive.id,
    type: 'drive-installed',
    payload: { slotId },
  });
  return { drive, event };
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
  it('keeps slot IDs, the drive slot_id and its events after rename and relabel', () => {
    const { layout, grid } = makeGrid(1, 2);
    const slot = slotsOf(grid.id)[0]!;
    const { drive, event } = installDrive(slot.id);
    const eventsBefore = repo.events.listByDrive(drive.id);

    layout.updateGrid(grid.id, { name: 'Renamed bays' });
    layout.updateSlotLabel(slot.id, { label: 'Bay 1' });

    const after = slotsOf(grid.id)[0]!;
    expect(after.id).toBe(slot.id);
    expect(after.label).toBe('Bay 1');
    expect(after.driveId).toBe(drive.id);
    expect(repo.drives.get(drive.id)?.slotId).toBe(slot.id);
    expect(repo.events.listByDrive(drive.id)).toEqual(eventsBefore);
    expect(repo.events.get(event.id)).toBeDefined();
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
    expect(repo.drives.get(drive.id)?.slotId).not.toBeNull();

    // Step 7 owns unassignment; free the slot directly so the grid can be removed.
    opened.sqlite
      .prepare('UPDATE drives SET slot_id = NULL, installed_on = NULL, status = ? WHERE id = ?')
      .run('spare', drive.id);
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

describe('R5: seeding runs once', () => {
  it('seeds NAS with Front bays, Internal SSDs and Boot, then sets the flag', () => {
    expect(seedInitialLayout(opened.db)).toBe(true);
    const [nas] = service().getLayout().enclosures;
    expect(nas!.name).toBe('NAS');
    expect(nas!.grids.map((g) => [g.name, g.rows, g.columns, g.orientation])).toEqual([
      ['Front bays', 2, 4, 'landscape'],
      ['Internal SSDs', 1, 2, 'landscape'],
      ['Boot', 1, 1, 'landscape'],
    ]);
    expect(nas!.grids[0]!.slots.map((s) => s.label)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
    ]);
    expect(nas!.grids[1]!.slots.map((s) => s.label)).toEqual(['Left', 'Right']);
    expect(nas!.grids[2]!.slots.map((s) => s.label)).toEqual(['NVMe']);
    expect(repo.meta.get('layout.seeded')).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
  });

  it('does not seed again after the user deletes everything', () => {
    seedInitialLayout(opened.db);
    const layout = service();
    const enclosure = layout.getLayout().enclosures[0]!;
    layout.deleteEnclosure(enclosure.id);
    expect(layout.getLayout().enclosures).toEqual([]);

    expect(seedInitialLayout(opened.db)).toBe(false);
    expect(layout.getLayout().enclosures).toEqual([]);
  });

  it('sets the flag without creating anything when enclosures already exist', () => {
    service().createEnclosure({ name: 'Mine' });
    expect(seedInitialLayout(opened.db)).toBe(true);
    expect(
      service()
        .getLayout()
        .enclosures.map((e) => e.name),
    ).toEqual(['Mine']);
  });
});

describe('HTTP API (app.inject)', () => {
  it('GET /api/layout returns the nested layout', async () => {
    seedInitialLayout(opened.db);
    const app = buildApp({ db: opened.db });
    const res = await app.inject({ method: 'GET', url: '/api/layout' });
    expect(res.statusCode).toBe(200);
    const body = layoutSchema.parse(res.json());
    expect(body.enclosures[0]!.grids[0]!.slots).toHaveLength(8);
    expect(body.enclosures[0]!.grids[0]!.slots[0]!.driveId).toBeNull();
    await app.close();
  });

  it('returns 409 with occupied slots when a shrink is blocked', async () => {
    seedInitialLayout(opened.db);
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
