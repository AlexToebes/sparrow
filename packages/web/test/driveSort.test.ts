import { describe, expect, it } from 'vitest';
import type { Layout, SlotStatus } from '@sparrow/shared';
import {
  DEFAULT_SORT,
  healthRank,
  nextSort,
  parseSort,
  slotRanks,
  sortDrives,
  sortSpares,
} from '../src/lib/driveSort';
import { makeDrive, makeSlot } from './utils';

const T = '2026-01-01T00:00:00.000Z';
const ids = (ds: { serial: string }[]) => ds.map((d) => d.serial);
const noCtx = { ranks: new Map<string, number>(), statusBySlot: new Map<string, SlotStatus>() };

describe('Post-MVP 22: spares shelf order', () => {
  const spare = (serial: string, capacityBytes: number | null, storageLocation: string | null) =>
    makeDrive({ id: serial, serial, status: 'spare', capacityBytes, storageLocation });

  it('orders by capacity (largest first), then location (missing last), then serial', () => {
    const list = [
      spare('A', 4e12, 'Box 2'),
      spare('B', 8e12, null),
      spare('C', 4e12, 'Box 10'),
      spare('D', null, 'Box 1'),
      spare('E', 8e12, 'Box 1'),
      spare('F', 4e12, 'Box 2'),
      spare('G', 12e12, 'Box 9'),
    ];
    // 12 TB; 8 TB with a location before 8 TB without; 4 TB: Box 2 (A, F by serial) before Box 10; unknown last
    expect(ids(sortSpares(list))).toEqual(['G', 'E', 'B', 'A', 'F', 'C', 'D']);
  });

  it('does not change the input array', () => {
    const list = [spare('B', 1, null), spare('A', 2, null)];
    sortSpares(list);
    expect(ids(list)).toEqual(['B', 'A']);
  });
});

describe('Post-MVP 22: drive sorting helpers', () => {
  it('reads and writes the URL state, falling back to serial ascending', () => {
    expect(parseSort(null, null)).toEqual(DEFAULT_SORT);
    expect(parseSort('bogus', 'desc')).toEqual({ key: 'serial', dir: 'desc' });
    expect(parseSort('capacity', 'desc')).toEqual({ key: 'capacity', dir: 'desc' });
    expect(nextSort(DEFAULT_SORT, 'serial')).toEqual({ key: 'serial', dir: 'desc' });
    expect(nextSort(DEFAULT_SORT, 'model')).toEqual({ key: 'model', dir: 'asc' });
    expect(nextSort(DEFAULT_SORT, 'capacity')).toEqual({ key: 'capacity', dir: 'desc' });
  });

  it('capacity is numeric and unknown stays last in both directions', () => {
    const list = [
      makeDrive({ id: 'a', serial: 'A', capacityBytes: 10e12 }),
      makeDrive({ id: 'b', serial: 'B', capacityBytes: null }),
      makeDrive({ id: 'c', serial: 'C', capacityBytes: 2e12 }),
    ];
    expect(ids(sortDrives(list, { key: 'capacity', dir: 'asc' }, noCtx))).toEqual(['C', 'A', 'B']);
    expect(ids(sortDrives(list, { key: 'capacity', dir: 'desc' }, noCtx))).toEqual(['A', 'C', 'B']);
  });

  it('text is case-insensitive natural order, ties fall back to serial', () => {
    const list = [
      makeDrive({ id: '1', serial: 'S3', model: 'bay 10' }),
      makeDrive({ id: '2', serial: 'S2', model: 'Bay 2' }),
      makeDrive({ id: '3', serial: 'S1', model: 'Bay 2' }),
      makeDrive({ id: '4', serial: 'S4', model: null }),
    ];
    expect(ids(sortDrives(list, { key: 'model', dir: 'asc' }, noCtx))).toEqual([
      'S1',
      'S2',
      'S3',
      'S4',
    ]);
    // Descending reverses the model order; ties still by serial ascending; unknown still last.
    expect(ids(sortDrives(list, { key: 'model', dir: 'desc' }, noCtx))).toEqual([
      'S3',
      'S1',
      'S2',
      'S4',
    ]);
    expect(
      ids(
        sortDrives(
          [makeDrive({ id: 'x', serial: 'a10' }), makeDrive({ id: 'y', serial: 'A9' })],
          DEFAULT_SORT,
          noCtx,
        ),
      ),
    ).toEqual(['A9', 'a10']);
  });

  it('status goes installed, spare, retired', () => {
    const list = [
      makeDrive({ id: 'r', serial: 'R', status: 'retired' }),
      makeDrive({ id: 's', serial: 'S', status: 'spare' }),
      makeDrive({ id: 'i', serial: 'I', status: 'installed' }),
    ];
    expect(ids(sortDrives(list, { key: 'status', dir: 'asc' }, noCtx))).toEqual(['I', 'S', 'R']);
    expect(ids(sortDrives(list, { key: 'status', dir: 'desc' }, noCtx))).toEqual(['R', 'S', 'I']);
  });

  const layout: Layout = {
    enclosures: [
      {
        id: 'e1',
        name: 'NAS',
        createdAt: T,
        updatedAt: T,
        grids: [
          {
            id: 'g1',
            enclosureId: 'e1',
            name: 'Front',
            rows: 1,
            columns: 3,
            orientation: 'landscape',
            createdAt: T,
            updatedAt: T,
            slots: [
              makeSlot({ id: 'f2', position: 1, label: 'Bay 2' }),
              makeSlot({ id: 'f10', position: 2, label: 'Bay 10' }),
              makeSlot({ id: 'f1', position: 0, label: 'Zed' }),
            ],
          },
          {
            id: 'g2',
            enclosureId: 'e1',
            name: 'Aardvark',
            rows: 1,
            columns: 1,
            orientation: 'landscape',
            createdAt: T,
            updatedAt: T,
            slots: [makeSlot({ id: 'b1', position: 0, label: 'Boot' })],
          },
        ],
      },
    ],
  };

  it('where: installed by grid then bay position, then spares by location, retired last', () => {
    const ranks = slotRanks(layout);
    const list = [
      makeDrive({ id: '1', serial: 'RET', status: 'retired' }),
      makeDrive({ id: '2', serial: 'SPB', status: 'spare', storageLocation: 'Box 10' }),
      makeDrive({ id: '3', serial: 'BOOT', slotId: 'b1' }),
      makeDrive({ id: '4', serial: 'F10', slotId: 'f10' }),
      makeDrive({ id: '5', serial: 'SPA', status: 'spare', storageLocation: 'Box 2' }),
      makeDrive({ id: '6', serial: 'F1', slotId: 'f1' }),
      makeDrive({ id: '7', serial: 'F2', slotId: 'f2' }),
      makeDrive({ id: '8', serial: 'SPN', status: 'spare', storageLocation: null }),
    ];
    const ctx = { ranks, statusBySlot: new Map<string, SlotStatus>() };
    // Layout order (Front before Aardvark, bay position not label), not the label strings.
    expect(ids(sortDrives(list, { key: 'where', dir: 'asc' }, ctx))).toEqual([
      'F1',
      'F2',
      'F10',
      'BOOT',
      'SPA',
      'SPB',
      'SPN',
      'RET',
    ]);
    expect(ids(sortDrives(list, { key: 'where', dir: 'desc' }, ctx))).toEqual([
      'SPB',
      'SPA',
      'SPN',
      'BOOT',
      'F10',
      'F2',
      'F1',
      'RET',
    ]);
  });

  it('health goes failed, missing, warning, ok, no data; non-installed last', () => {
    const st = (slotId: string, over: Partial<SlotStatus>): SlotStatus => ({
      slotId,
      driveId: slotId,
      health: 'ok',
      lastReportedAt: T,
      temperatureC: null,
      detailUrl: null,
      stale: false,
      flag: null,
      ...over,
    });
    const statuses = [
      st('ok', { health: 'ok' }),
      st('warn', { health: 'warning' }),
      st('fail', { health: 'failed' }),
      st('miss', { flag: { kind: 'missing', reason: 'stale' } }),
      st('unk', { health: 'unknown' }),
    ];
    const list = [
      makeDrive({ id: 'sp', serial: 'SPARE', status: 'spare' }),
      ...['ok', 'warn', 'fail', 'miss', 'unk'].map((s) =>
        makeDrive({ id: s, serial: s.toUpperCase(), slotId: s }),
      ),
    ];
    const ctx = { ranks: new Map(), statusBySlot: new Map(statuses.map((s) => [s.slotId, s])) };
    expect(ids(sortDrives(list, { key: 'health', dir: 'asc' }, ctx))).toEqual([
      'FAIL',
      'MISS',
      'WARN',
      'OK',
      'UNK',
      'SPARE',
    ]);
    expect(ids(sortDrives(list, { key: 'health', dir: 'desc' }, ctx))).toEqual([
      'UNK',
      'OK',
      'WARN',
      'MISS',
      'FAIL',
      'SPARE',
    ]);
    expect(healthRank(list[0]!, undefined)).toBeNull();
  });
});
