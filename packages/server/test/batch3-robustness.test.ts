import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Observation } from '@sparrow/shared';
import { assignDrive, removeToSpares, retireDrive, sendForRma } from '../src/core/assignment.js';
import { createDrive, getDrive } from '../src/core/drives.js';
import type { DomainError } from '../src/core/errors.js';
import { createFromObservation, importRetired, linkObservation } from '../src/core/inbox.js';
import { createLayoutService } from '../src/core/layout.js';
import { moveDrive } from '../src/core/move.js';
import { joinPool, leavePool } from '../src/core/memberships.js';
import { createPoller } from '../src/core/poller.js';
import type { DriveDataProvider } from '../src/core/provider-port.js';
import { errorReason, safeUrlForLog } from '../src/core/safe-url.js';
import { applySuggestions, getDriveSuggestions } from '../src/core/suggestions.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import { createRepositories } from '../src/db/repositories.js';
import { pools } from '../src/db/schema.js';
import { fitObservedText } from '../src/core/observation-text.js';

let opened: OpenedDatabase;
beforeEach(() => {
  opened = openDatabase(':memory:');
});
afterEach(() => opened.sqlite.close());
const db = () => opened.db;

function slots(): string[] {
  const layout = createLayoutService(db());
  const enclosure = layout.createEnclosure({ name: 'NAS' });
  layout.createGrid(enclosure.id, { name: 'Front', rows: 1, columns: 3, orientation: 'landscape' });
  return layout
    .getLayout()
    .enclosures.flatMap((e) => e.grids.flatMap((g) => g.slots.map((s) => s.id)));
}
function thrown(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (e) {
    return e as DomainError;
  }
  throw new Error('expected a throw');
}
const spare = (serial: string) => createDrive(db(), { serial });
const INSTALLED = '2026-05-10';
const EARLIER = '2026-05-01';
const MESSAGE = /before it was installed \(installed on 2026-05-10\); the date given is 2026-05-01/;

function installed(serial: string, slot: string, poolId?: string) {
  const d = spare(serial);
  assignDrive(db(), {
    driveId: d.id,
    slotId: slot,
    installedOn: INSTALLED,
    poolId: poolId ?? null,
  });
  return d;
}

describe('R60, R69 (changed 2026-10-13): no removal date before the installation date', () => {
  it('retire an installed drive', () => {
    const [s] = slots();
    const d = installed('A', s!);
    const err = thrown(() => retireDrive(db(), d.id, { reason: 'failed', date: EARLIER }));
    expect(err.code).toBe('invalid');
    expect(err.message).toMatch(MESSAGE);
    expect(getDrive(db(), d.id).status).toBe('installed');
  });

  it('RMA an installed drive', () => {
    const [s] = slots();
    const d = installed('A', s!);
    expect(thrown(() => sendForRma(db(), d.id, { date: EARLIER })).message).toMatch(MESSAGE);
    expect(getDrive(db(), d.id).status).toBe('installed');
  });

  it('remove to spares', () => {
    const [s] = slots();
    const d = installed('A', s!);
    expect(thrown(() => removeToSpares(db(), d.id, { removedOn: EARLIER })).message).toMatch(
      MESSAGE,
    );
  });

  it.each([
    ['spares', { kind: 'spares' as const }],
    ['retire', { kind: 'retire' as const, reason: 'failed' as const }],
    ['rma', { kind: 'rma' as const }],
  ])('Move to %s', (_name, destination) => {
    const [s] = slots();
    const d = installed('A', s!);
    const err = thrown(() => moveDrive(db(), d.id, { destination, date: EARLIER }));
    expect(err.code).toBe('invalid');
    expect(err.message).toMatch(MESSAGE);
    expect(getDrive(db(), d.id).status).toBe('installed');
  });

  it('Move to another bay', () => {
    const [s, t] = slots();
    const d = installed('A', s!);
    expect(
      thrown(() =>
        moveDrive(db(), d.id, { destination: { kind: 'slot', slotId: t! }, date: EARLIER }),
      ).message,
    ).toMatch(MESSAGE);
  });

  it.each(['spare', 'retire', 'rma'] as const)(
    'occupant resolution (%s) when assigning into an occupied bay',
    (action) => {
      const [s] = slots();
      const a = installed('A', s!);
      const b = spare('B');
      const occupant =
        action === 'spare'
          ? { action }
          : action === 'retire'
            ? { action, reason: 'failed' as const }
            : { action };
      const err = thrown(() =>
        assignDrive(db(), { driveId: b.id, slotId: s!, installedOn: EARLIER, occupant }),
      );
      expect(err.code).toBe('invalid');
      expect(err.message).toMatch(MESSAGE);
      expect(getDrive(db(), a.id).status).toBe('installed');
      expect(getDrive(db(), b.id).status).toBe('spare');
    },
  );

  it('occupant resolution in a Move into an occupied bay', () => {
    const [s, t] = slots();
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: s!, installedOn: '2026-01-01' });
    installed('B', t!);
    const err = thrown(() =>
      moveDrive(db(), a.id, {
        destination: { kind: 'slot', slotId: t!, occupant: { action: 'spare' } },
        date: EARLIER,
      }),
    );
    expect(err.message).toMatch(MESSAGE);
  });

  it('swap names the drive whose installation date is later', () => {
    const [s, t] = slots();
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: s!, installedOn: '2026-01-01' });
    installed('B', t!);
    const err = thrown(() =>
      moveDrive(db(), a.id, {
        destination: { kind: 'slot', slotId: t!, occupant: { action: 'swap' } },
        date: EARLIER,
      }),
    );
    expect(err.message).toMatch(MESSAGE);
  });

  it('the same date as the installation date, an unknown installation date and a null date are fine', () => {
    const [s, t, u] = slots();
    const a = installed('A', s!);
    expect(retireDrive(db(), a.id, { reason: 'failed', date: INSTALLED }).status).toBe('retired');
    const b = spare('B');
    assignDrive(db(), { driveId: b.id, slotId: t!, installedOn: null });
    expect(removeToSpares(db(), b.id, { removedOn: EARLIER }).status).toBe('spare');
    const c = installed('C', u!);
    expect(retireDrive(db(), c.id, { reason: 'failed', date: null }).status).toBe('retired');
  });

  it('a spare (no installation) can be retired on any date', () => {
    const d = spare('A');
    expect(retireDrive(db(), d.id, { reason: 'other', date: '2001-01-01' }).status).toBe('retired');
  });

  it('pool join and leave dates', () => {
    const [s] = slots();
    const at = new Date().toISOString();
    db()
      .insert(pools)
      .values({ id: 'p1', name: 'tank', layoutLabel: null, createdAt: at, updatedAt: at })
      .run();
    const d = installed('A', s!);
    const before = `${EARLIER}T12:00:00.000Z`;
    expect(
      thrown(() => joinPool(db(), d.id, { poolId: 'p1', role: 'data', startedAt: before })).message,
    ).toMatch(MESSAGE);
    joinPool(db(), d.id, { poolId: 'p1', role: 'data', startedAt: `${INSTALLED}T12:00:00.000Z` });
    expect(thrown(() => leavePool(db(), d.id, { endedAt: before })).message).toMatch(MESSAGE);
  });
});

describe('R72 long provider strings are cut to the record limits', () => {
  const LONG = 'M'.repeat(300);
  const obs = (serial: string, extra: Partial<Observation> = {}): Observation => ({
    serial,
    health: 'ok',
    lastReportedAt: '2026-03-04T05:06:07.000Z',
    state: 'active',
    model: LONG,
    ...extra,
  });
  const snapshot = (observations: Observation[]) =>
    createRepositories(db()).snapshot.put({
      providerId: 'fake',
      observations,
      lastSuccessAt: '2026-03-04T05:06:07.000Z',
      lastAttemptAt: '2026-03-04T05:06:07.000Z',
    });

  it('fitObservedText trims, truncates and avoids half a surrogate pair', () => {
    expect(fitObservedText('model', '  x  ')).toBe('x');
    expect(fitObservedText('model', '   ')).toBeUndefined();
    expect(fitObservedText('model', 'a'.repeat(250))).toHaveLength(200);
    expect(fitObservedText('model', 'a'.repeat(199) + '😀')).toBe('a'.repeat(199));
  });

  it('creating a drive from a Discovered observation with a 300-char model works', () => {
    const [s] = slots();
    snapshot([obs('LONG1', { formFactor: 'F'.repeat(300), wwn: 'W'.repeat(150) })]);
    const { drive } = createFromObservation(db(), 'fake', 'LONG1', { slotId: s! });
    expect(drive.model).toHaveLength(200);
    expect(drive.formFactor).toHaveLength(200);
    expect(drive.wwn).toHaveLength(100);
  });

  it('linking a spare fills the truncated model, and no "differs" suggestion remains', () => {
    const [s] = slots();
    const d = spare('LONG2');
    snapshot([obs('LONG2')]);
    const { drive } = linkObservation(db(), 'fake', 'LONG2', { driveId: d.id, slotId: s! });
    expect(drive.model).toBe(LONG.slice(0, 200));
    expect(getDriveSuggestions(db(), 'fake', d.id)).toEqual([]);
  });

  it('suggestions offer the truncated value, applying it sticks, and it no longer differs', () => {
    const d = spare('LONG3');
    snapshot([obs('LONG3')]);
    const [fill] = getDriveSuggestions(db(), 'fake', d.id);
    expect(fill).toMatchObject({ field: 'model', kind: 'fill', suggested: LONG.slice(0, 200) });
    applySuggestions(db(), 'fake', d.id, ['model']);
    expect(getDriveSuggestions(db(), 'fake', d.id)).toEqual([]);
  });

  it('importing a retired drive with a 300-char model works', () => {
    snapshot([obs('LONG4', { state: 'decommissioned' })]);
    const [retired] = importRetired(db(), 'fake', {
      items: [{ observationKey: 'LONG4', reason: 'failed' }],
    });
    expect(retired!.model).toHaveLength(200);
  });
});

describe('poll failure logs name the provider URL (no credentials) and the reason', () => {
  it('safeUrlForLog strips userinfo, query and fragment', () => {
    expect(safeUrlForLog('http://user:secret@scrutiny:8080/base?token=abc#x')).toBe(
      'http://scrutiny:8080/base',
    );
    expect(safeUrlForLog('http://scrutiny:8080/')).toBe('http://scrutiny:8080');
    expect(safeUrlForLog('not a url')).toBeUndefined();
    expect(safeUrlForLog(undefined)).toBeUndefined();
  });

  it('errorReason adds the underlying cause', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:8080'), {
      code: 'ECONNREFUSED',
    });
    expect(errorReason(new TypeError('fetch failed', { cause }))).toBe(
      'fetch failed (ECONNREFUSED connect ECONNREFUSED 10.0.0.1:8080)',
    );
    expect(errorReason(new Error('down'))).toBe('down');
  });

  it('the poller logs the sanitized URL and the reason; the stored error is unchanged', async () => {
    const provider: DriveDataProvider = {
      id: 'scrutiny',
      endpoint: 'http://me:hunter2@scrutiny:8080',
      capabilities: { drives: true, pools: false },
      expectedUpdateIntervalHours: 24,
      fetchSnapshot: async () => {
        throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND scrutiny') });
      },
      checkConnection: async () => ({ ok: true }),
    };
    const log = { warn: vi.fn() };
    const poller = createPoller({ db: db(), provider, intervalMs: 1000, log });
    expect(await poller.pollOnce()).toEqual({ ok: false, error: 'fetch failed' });
    const [obj, msg] = log.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(obj.url).toBe('http://scrutiny:8080');
    expect(msg).toContain('http://scrutiny:8080');
    expect(msg).toContain('ENOTFOUND');
    expect(msg).not.toContain('hunter2');
    expect(JSON.stringify(obj.url)).not.toContain('hunter2');
  });
});
