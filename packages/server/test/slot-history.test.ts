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
import { events, slots as slotsTable } from '../src/db/schema.js';
import { updateDrive } from '../src/core/drives.js';
import { eq } from 'drizzle-orm';

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
  it('R74: reads the occupancy from installed / uninstalled events, newest first, with each way out', () => {
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

  it('R73, R74: a swap shows in both bays as a swap out and the other drive in; layout events do not disturb it', () => {
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
      outcome: { kind: 'swapped', withSerial: 'B', toSlotId: slots[1], toLabel: 'Slot 2' },
    });
    const second = getSlotHistory(db(), slots[1]!).entries;
    expect(second).toHaveLength(2);
    expect(second[0]).toMatchObject({ serial: 'A', installedOn: '2024-06-06', outcome: null });
    expect(second[1]).toMatchObject({
      serial: 'B',
      removedOn: '2024-06-06',
      outcome: { kind: 'swapped', withSerial: 'A', toSlotId: slots[0], toLabel: 'Slot 1' },
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

  it('R74: a replacement shows the outgoing drive with who replaced it and how it left; the newcomer is current', () => {
    const { slots } = setup();
    const [a, b, c, d] = [spare('A'), spare('B'), spare('C'), spare('D')] as const;
    const s0 = slots[0]!;
    assignDrive(db(), { driveId: a.id, slotId: s0, installedOn: '2022-01-01' });
    assignDrive(db(), {
      driveId: b.id,
      slotId: s0,
      installedOn: '2023-01-02',
      occupant: { action: 'retire', reason: 'failed', date: '2023-01-02' },
    });
    assignDrive(db(), {
      driveId: c.id,
      slotId: s0,
      installedOn: '2024-01-03',
      occupant: { action: 'spare', removedOn: '2024-01-03' },
    });
    assignDrive(db(), {
      driveId: d.id,
      slotId: s0,
      installedOn: '2025-01-05',
      occupant: { action: 'rma', date: '2025-01-05' },
    });
    const e = getSlotHistory(db(), s0).entries;
    expect(e.map((x) => x.serial)).toEqual(['D', 'C', 'B', 'A']);
    expect(e[0]).toMatchObject({ installedOn: '2025-01-05', outcome: null, replacedBy: null });
    expect(e[1]).toMatchObject({
      serial: 'C',
      installedOn: '2024-01-03',
      removedOn: '2025-01-05',
      outcome: { kind: 'rma' },
      replacedBy: { driveId: d.id, serial: 'D', capacityBytes: 4e12 },
    });
    expect(e[2]).toMatchObject({
      serial: 'B',
      removedOn: '2024-01-03',
      outcome: { kind: 'spares' },
      replacedBy: { serial: 'C' },
    });
    expect(e[3]).toMatchObject({
      serial: 'A',
      installedOn: '2022-01-01',
      removedOn: '2023-01-02',
      outcome: { kind: 'retired', reason: 'failed' },
      replacedBy: { serial: 'B' },
    });
  });

  it('R73, R74: a move into an occupied bay with a spare in the vacated bay reads right in BOTH bays', () => {
    const { slots } = setup();
    const [a, b, c] = [spare('A'), spare('B'), spare('C')] as const;
    const [s0, s1] = [slots[0]!, slots[1]!];
    assignDrive(db(), { driveId: a.id, slotId: s0, installedOn: '2022-01-01' });
    assignDrive(db(), { driveId: b.id, slotId: s1, installedOn: '2022-02-02' });
    moveDrive(db(), a.id, {
      destination: { kind: 'slot', slotId: s1, occupant: { action: 'spare' } },
      replacement: { driveId: c.id },
      date: '2024-06-06',
    });
    const first = getSlotHistory(db(), s0).entries;
    expect(first.map((x) => x.serial)).toEqual(['C', 'A']);
    expect(first[0]).toMatchObject({ installedOn: '2024-06-06', outcome: null });
    expect(first[1]).toMatchObject({
      installedOn: '2022-01-01',
      removedOn: '2024-06-06',
      outcome: { kind: 'moved', toSlotId: s1, toLabel: 'Slot 2' },
      replacedBy: { serial: 'C' },
    });
    const second = getSlotHistory(db(), s1).entries;
    // A arrives once (the vacated bay's event links this bay as `to` too, and is not counted twice).
    expect(second.map((x) => x.serial)).toEqual(['A', 'B']);
    expect(second[0]).toMatchObject({ installedOn: '2024-06-06', outcome: null });
    expect(second[1]).toMatchObject({
      removedOn: '2024-06-06',
      outcome: { kind: 'spares' },
      replacedBy: { serial: 'A' },
    });
  });

  it('R73, R74: a move into an occupied bay with no spare still ends the mover in the vacated bay', () => {
    const { slots } = setup();
    const [a, b] = [spare('A'), spare('B')] as const;
    const [s0, s1] = [slots[0]!, slots[1]!];
    assignDrive(db(), { driveId: a.id, slotId: s0, installedOn: '2022-01-01' });
    assignDrive(db(), { driveId: b.id, slotId: s1, installedOn: '2022-02-02' });
    moveDrive(db(), a.id, {
      destination: {
        kind: 'slot',
        slotId: s1,
        occupant: { action: 'retire', reason: 'replaced' },
      },
      date: '2024-06-06',
    });
    const first = getSlotHistory(db(), s0).entries;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      serial: 'A',
      removedOn: '2024-06-06',
      outcome: { kind: 'moved', toSlotId: s1 },
      replacedBy: null,
    });
    const second = getSlotHistory(db(), s1).entries;
    expect(second.map((x) => x.serial)).toEqual(['A', 'B']);
    expect(second[1]).toMatchObject({
      outcome: { kind: 'retired', reason: 'replaced' },
      replacedBy: { serial: 'A' },
    });
  });

  it('R73, R74: a spare replacing a drive moved to an EMPTY bay: the target bay sees the mover arrive', () => {
    const { slots } = setup();
    const [a, c] = [spare('A'), spare('C')] as const;
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, installedOn: '2022-01-01' });
    moveDrive(db(), a.id, {
      destination: { kind: 'slot', slotId: slots[2]! },
      replacement: { driveId: c.id },
      date: '2024-06-06',
    });
    const target = getSlotHistory(db(), slots[2]!).entries;
    expect(target).toHaveLength(1);
    expect(target[0]).toMatchObject({ serial: 'A', installedOn: '2024-06-06', outcome: null });
    const origin = getSlotHistory(db(), slots[0]!).entries;
    expect(origin[0]).toMatchObject({ serial: 'C', outcome: null });
    expect(origin[1]).toMatchObject({
      serial: 'A',
      outcome: { kind: 'moved', toSlotId: slots[2] },
      replacedBy: { serial: 'C' },
    });
  });

  it('R39, R74: deleting the target grid keeps the move outcome readable from the link snapshots', () => {
    const { layout, slots } = setup();
    const extra = layout.createGrid(layout.getLayout().enclosures[0]!.id, {
      name: 'Rear',
      rows: 1,
      columns: 1,
      orientation: 'landscape',
    });
    const rear = layout.getLayout().enclosures[0]!.grids.find((g) => g.id === extra.id)!.slots[0]!;
    layout.updateSlotLabel(rear.id, { label: 'Hot swap' });
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, installedOn: '2022-01-01' });
    moveDrive(db(), a.id, { destination: { kind: 'slot', slotId: rear.id }, date: '2023-03-03' });
    removeToSpares(db(), a.id, { removedOn: '2023-04-04' });
    layout.deleteGrid(extra.id);
    const h = getSlotHistory(db(), slots[0]!);
    expect(h.entries[0]!.outcome).toEqual({
      kind: 'moved',
      toSlotId: rear.id,
      toLabel: 'Hot swap',
      toGridName: 'Rear',
    });
    // The events outlive the slot (no foreign key), with the label and grid copied in.
    const links = db().select().from(events).where(eq(events.slotId, rear.id)).all();
    expect(links.length).toBeGreaterThanOrEqual(3);
    expect(links.every((l) => l.gridName === 'Rear' && l.slotLabel === 'Hot swap')).toBe(true);
    expect(db().select().from(slotsTable).where(eq(slotsTable.id, rear.id)).all()).toEqual([]);
  });

  it('R74: slot history reads the indexed slot column, not the payload JSON', () => {
    const plan = opened.sqlite
      .prepare('EXPLAIN QUERY PLAN SELECT id FROM events WHERE slot_id = ?')
      .all('x') as { detail: string }[];
    expect(plan.map((p) => p.detail).join(' ')).toMatch(/events_slot_idx/);
  });

  it('R68, R74: a later edit of the installation date moves the stay in the slot history', () => {
    const { slots } = setup();
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, installedOn: '2022-01-01' });
    updateDrive(db(), a.id, { installedOn: '2021-12-24' });
    expect(getSlotHistory(db(), slots[0]!).entries[0]).toMatchObject({
      serial: 'A',
      installedOn: '2021-12-24',
      outcome: null,
    });
    updateDrive(db(), a.id, { installedOn: null });
    removeToSpares(db(), a.id, { removedOn: '2023-01-01' });
    expect(getSlotHistory(db(), slots[0]!).entries[0]).toMatchObject({
      installedOn: null,
      removedOn: '2023-01-01',
    });
  });

  it('R74: how it left comes only from the SAME activity: a later retirement does not rewrite an earlier removal', () => {
    const { slots } = setup();
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, installedOn: '2022-01-01' });
    removeToSpares(db(), a.id, { removedOn: '2022-06-01' });
    retireDrive(db(), a.id, { reason: 'failed', date: '2022-06-02' }); // a spare is retired later
    expect(getSlotHistory(db(), slots[0]!).entries[0]).toMatchObject({
      outcome: { kind: 'spares' },
      removedOn: '2022-06-01',
    });
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
