import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { SlotHistory } from '@sparrow/shared';
import { buildApp } from '../src/api/app.js';
import { assignDrive, removeToSpares, retireDrive, sendForRma } from '../src/core/assignment.js';
import { createDrive } from '../src/core/drives.js';
import { createLayoutService } from '../src/core/layout.js';
import { moveDrive } from '../src/core/move.js';
import { getSlotHistory } from '../src/core/slot-history.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';

let opened: OpenedDatabase;
let app: FastifyInstance;
beforeEach(async () => {
  opened = openDatabase(':memory:');
  app = buildApp({ db: opened.db });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  opened.sqlite.close();
});

const db = () => opened.db;
const spare = (serial: string) =>
  createDrive(db(), { serial, capacityBytes: 4e12, driveType: 'HDD' });

function setup() {
  const layout = createLayoutService(db());
  const enclosure = layout.createEnclosure({ name: 'NAS' });
  const grid = layout.createGrid(enclosure.id, {
    name: 'Front',
    rows: 1,
    columns: 4,
    orientation: 'landscape',
  });
  const slots = layout.getLayout().enclosures[0]!.grids[0]!.slots.map((s) => s.id);
  return { layout, grid, slots };
}

describe('slot history (R74)', () => {
  it('R74: pairs installs and removals, newest first, with each way out', () => {
    const { slots } = setup();
    const [a, b, c, d, e] = ['A', 'B', 'C', 'D', 'E'].map(spare) as [
      ReturnType<typeof spare>,
      ReturnType<typeof spare>,
      ReturnType<typeof spare>,
      ReturnType<typeof spare>,
      ReturnType<typeof spare>,
    ];
    const s0 = slots[0]!;
    assignDrive(db(), { driveId: a.id, slotId: s0, installedOn: '2022-08-19' });
    removeToSpares(db(), a.id, { removedOn: '2023-01-02' }); // back to spares
    assignDrive(db(), { driveId: b.id, slotId: s0, installedOn: '2023-02-01' });
    moveDrive(db(), b.id, { destination: { kind: 'slot', slotId: slots[2]! }, date: '2023-05-05' });
    assignDrive(db(), { driveId: c.id, slotId: s0, installedOn: null });
    retireDrive(db(), c.id, { reason: 'failed', date: '2024-03-14' });
    assignDrive(db(), { driveId: d.id, slotId: s0, installedOn: '2024-04-01' });
    sendForRma(db(), d.id, { date: '2025-01-01' });
    assignDrive(db(), { driveId: e.id, slotId: s0, installedOn: '2025-02-02' });

    const h = getSlotHistory(db(), s0);
    expect(h.slot).toMatchObject({ id: s0, label: 'Slot 1', gridName: 'Front' });
    expect(h.entries.map((x) => x.serial)).toEqual(['E', 'D', 'C', 'B', 'A']);
    expect(h.entries[0]).toMatchObject({
      serial: 'E',
      capacityBytes: 4e12,
      driveType: 'HDD',
      installedOn: '2025-02-02',
      removedOn: null,
      outcome: null,
    });
    expect(h.entries[1]).toMatchObject({ removedOn: '2025-01-01', outcome: { kind: 'rma' } });
    expect(h.entries[2]).toMatchObject({
      installedOn: null,
      removedOn: '2024-03-14',
      outcome: { kind: 'retired', reason: 'failed' },
    });
    expect(h.entries[2]!.installedRecordedAt).toEqual(expect.any(String));
    expect(h.entries[3]).toMatchObject({
      removedOn: '2023-05-05',
      outcome: { kind: 'moved', toSlotId: slots[2], toLabel: 'Slot 3', toGridName: 'Front' },
    });
    expect(h.entries[4]).toMatchObject({
      installedOn: '2022-08-19',
      removedOn: '2023-01-02',
      outcome: { kind: 'spares' },
    });
    expect(h.entries[4]!.removedRecordedAt).toEqual(expect.any(String));
  });

  it('R74: the target bay of a move sees the drive arrive, and an unrecorded removal date stays null', () => {
    const { slots } = setup();
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    moveDrive(db(), a.id, { destination: { kind: 'slot', slotId: slots[1]! }, date: null });
    removeToSpares(db(), a.id, { removedOn: null });
    const first = getSlotHistory(db(), slots[0]!).entries;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ removedOn: null, outcome: { kind: 'moved' } });
    const second = getSlotHistory(db(), slots[1]!).entries;
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      installedOn: null,
      removedOn: null,
      outcome: { kind: 'spares' },
    });
  });

  it('R73, R74: a swap shows in both bays as a move out and the other drive in; layout events do not disturb it', () => {
    const { layout, grid, slots } = setup();
    const [a, b] = [spare('A'), spare('B')] as const;
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, installedOn: '2022-01-01' });
    assignDrive(db(), { driveId: b.id, slotId: slots[1]!, installedOn: '2022-02-02' });
    layout.updateGrid(grid.id, { name: 'Drawer' }); // writes a driveId-less grid-updated event
    moveDrive(db(), a.id, {
      destination: { kind: 'slot', slotId: slots[1]!, occupant: { action: 'swap' } },
      date: '2024-06-06',
    });
    const first = getSlotHistory(db(), slots[0]!).entries;
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({ serial: 'B', installedOn: '2024-06-06', outcome: null });
    expect(first[1]).toMatchObject({
      serial: 'A',
      removedOn: '2024-06-06',
      outcome: { kind: 'moved', toSlotId: slots[1] },
    });
    const second = getSlotHistory(db(), slots[1]!).entries;
    expect(second).toHaveLength(2);
    expect(second[0]).toMatchObject({ serial: 'A', installedOn: '2024-06-06', outcome: null });
    expect(second[1]).toMatchObject({
      serial: 'B',
      removedOn: '2024-06-06',
      outcome: { kind: 'moved', toSlotId: slots[0] },
    });
  });

  it('R39, R74: renaming the bay and grid keeps the history; labels are the current names', () => {
    const { layout, grid, slots } = setup();
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    removeToSpares(db(), a.id);
    assignDrive(db(), { driveId: a.id, slotId: slots[1]! });
    removeToSpares(db(), a.id);
    layout.updateSlotLabel(slots[0]!, { label: 'Top left' });
    layout.updateGrid(grid.id, { name: 'Drawer' });
    // Move the drive from the renamed bay: its target label is read live.
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    moveDrive(db(), a.id, { destination: { kind: 'slot', slotId: slots[1]! } });
    const h = getSlotHistory(db(), slots[0]!);
    expect(h.slot).toEqual({ id: slots[0], label: 'Top left', gridName: 'Drawer' });
    expect(h.entries).toHaveLength(2);
    expect(h.entries[0]!.outcome).toMatchObject({ kind: 'moved', toGridName: 'Drawer' });
  });

  it('R74: an empty bay has no entries; GET returns 404 for an unknown bay', async () => {
    const { slots } = setup();
    const res = await app.inject({ method: 'GET', url: `/api/slots/${slots[3]}/history` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as SlotHistory).entries).toEqual([]);
    const missing = await app.inject({ method: 'GET', url: '/api/slots/nope/history' });
    expect(missing.statusCode).toBe(404);
  });
});
