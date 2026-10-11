import type { Drive, LayoutSlot } from '@sparrow/shared';
import { makeDrive, makeSlot } from './utils';

export const T = '2026-01-01T00:00:00.000Z';

export interface Call {
  method: string;
  url: string;
  body: unknown;
}

export const grid = (
  id: string,
  name: string,
  rows: number,
  columns: number,
  slots: LayoutSlot[],
  orientation: 'landscape' | 'portrait' = 'landscape',
  enclosureId = 'e1',
) => ({ id, enclosureId, name, rows, columns, orientation, createdAt: T, updatedAt: T, slots });

export const enclosure = (id: string, name: string, grids: ReturnType<typeof grid>[]) => ({
  id,
  name,
  createdAt: T,
  updatedAt: T,
  grids,
});

/** A 2 x 2 "Front bays": Bay 1 (AAA0), Bay 3 (CCC2) occupied, Bay 2 and Bay 4 empty. */
export function fixtureData() {
  const slots = [
    makeSlot({ id: 's0', position: 0, label: 'Bay 1', driveId: 'd0' }),
    makeSlot({ id: 's1', position: 1, label: 'Bay 2' }),
    makeSlot({ id: 's2', position: 2, label: 'Bay 3', driveId: 'd2' }),
    makeSlot({ id: 's3', position: 3, label: 'Bay 4' }),
  ];
  const drives: Drive[] = [
    makeDrive({ id: 'd0', serial: 'AAA0', slotId: 's0', capacityBytes: 4e12 }),
    makeDrive({ id: 'd2', serial: 'CCC2', slotId: 's2', capacityBytes: 4e12 }),
    makeDrive({
      id: 'd9',
      serial: 'SPARE9',
      status: 'spare',
      capacityBytes: 8e12,
      model: 'Big',
      condition: 'tested',
      storageLocation: 'Desk drawer',
    }),
    makeDrive({ id: 'd8', serial: 'SPARE8', status: 'spare', capacityBytes: 4e12, model: 'Mid' }),
    makeDrive({
      id: 'd7',
      serial: 'OLD7',
      status: 'retired',
      retirementReason: 'failed',
      retirementDate: '2025-05-05',
    }),
  ];
  return { slots, drives };
}

/**
 * Fetch mock that records every call and answers by "METHOD url". Unknown routes are 404.
 * `flagSlot` marks that slot's drive as missing in GET /api/status.
 */
export function setupServer(
  extra: Record<string, unknown | ((body: unknown) => Response)> = {},
  opts: { slots?: LayoutSlot[]; drives?: Drive[]; flagSlot?: string; layoutGrids?: unknown } = {},
) {
  const calls: Call[] = [];
  const data = fixtureData();
  const slots = opts.slots ?? data.slots;
  const drives = opts.drives ?? data.drives;
  const routes: Record<string, unknown | ((body: unknown) => Response)> = {
    'GET /api/layout': {
      enclosures: opts.layoutGrids ?? [
        enclosure('e1', 'NAS', [grid('g1', 'Front bays', 2, 2, slots)]),
      ],
    },
    'GET /api/drives': drives,
    'GET /api/drives?status=spare': drives.filter((d) => d.status === 'spare'),
    'GET /api/inbox': { entries: [], unidentified: [], retiredCandidates: [], count: 0 },
    'GET /api/suggestions': { byDriveId: {} },
    'GET /api/provider/status': {
      providerId: 'none',
      reachable: true,
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastError: null,
      observationCount: 0,
    },
    'GET /api/status': {
      providerId: 'scrutiny',
      providerStale: false,
      staleAfterHours: 36,
      lastSuccessAt: new Date().toISOString(),
      slots: slots
        .filter((s) => s.driveId)
        .map((s) => ({
          slotId: s.id,
          driveId: s.driveId,
          health: s.id === 's2' ? 'warning' : 'ok',
          lastReportedAt: new Date().toISOString(),
          temperatureC: 33,
          detailUrl: null,
          stale: false,
          flag: s.id === opts.flagSlot ? { kind: 'missing', reason: 'not-reported' } : null,
        })),
    },
    'GET /api/pools': [
      { id: 'p1', name: 'tank', layoutLabel: 'raidz2', createdAt: T, updatedAt: T, memberCount: 0 },
    ],
    'GET /api/pools/p1': {
      id: 'p1',
      name: 'tank',
      layoutLabel: 'raidz2',
      createdAt: T,
      updatedAt: T,
      memberCount: 0,
      members: [],
    },
    'GET /api/slots/s0/assignment-defaults': { poolId: 'p1', role: 'data', previousDriveId: 'd0' },
    'GET /api/slots/s1/assignment-defaults': { poolId: null, role: null, previousDriveId: null },
    'GET /api/slots/s2/assignment-defaults': {
      poolId: 'p1',
      role: 'hot-spare',
      previousDriveId: 'd2',
    },
    'GET /api/slots/s3/assignment-defaults': { poolId: null, role: null, previousDriveId: null },
    'GET /api/drives/d0/events': [],
    'GET /api/drives/d2/events': [],
    'POST /api/slots/s0/assign': { drive: drives[2], occupant: drives[0] },
    'POST /api/slots/s1/assign': { drive: drives[2] },
    'POST /api/slots/s2/assign': { drive: drives[2], occupant: drives[1] },
    'POST /api/slots/s3/assign': { drive: drives[2] },
    'POST /api/drives/d0/move': { drive: drives[0] },
    'POST /api/drives/d2/move': { drive: drives[1] },
    'POST /api/drives/d0/remove': drives[0],
    'POST /api/drives/d2/remove': drives[1],
    ...extra,
  };
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const hit = routes[`${method} ${url}`];
    if (typeof hit === 'function') return Promise.resolve((hit as (b: unknown) => Response)(body));
    if (hit !== undefined)
      return Promise.resolve(new Response(JSON.stringify(hit), { status: 200 }));
    return Promise.resolve(
      new Response(
        JSON.stringify({ error: { code: 'not-found', message: `no mock ${method} ${url}` } }),
        { status: 404 },
      ),
    );
  }) as typeof fetch;
  return calls;
}

export const posts = (calls: Call[], url: string) =>
  calls.filter((c) => c.method !== 'GET' && c.url === url);

export const errorResponse = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ error: { code, message } }), { status });
