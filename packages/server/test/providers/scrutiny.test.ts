import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProvider } from '../../src/providers/index.js';
import { runProviderContract } from '../../src/providers/contract.js';
import { loadScrutinyConfig } from '../../src/providers/scrutiny/config.js';
import { createScrutinyProvider } from '../../src/providers/scrutiny/index.js';
import { mapHealth, mapSummary } from '../../src/providers/scrutiny/mapping.js';

const fixture: unknown = JSON.parse(
  readFileSync(new URL('../fixtures/scrutiny-summary.json', import.meta.url), 'utf8'),
);
const BASE = 'http://scrutiny.test:8080';
const all = mapSummary(fixture, BASE);
const bySerial = (s: string) => {
  const o = all.find((x) => x.serial === s);
  if (!o) throw new Error(`no observation with serial ${s}`);
  return o;
};

describe('Scrutiny mapping against the real capture (R46, R59, Appendix B)', () => {
  it('emits one observation per summary entry, archived included', () => {
    expect(all).toHaveLength(16);
    expect(all.filter((o) => o.state === 'decommissioned')).toHaveLength(4);
  });

  it('maps a healthy active 3.5in HDD fully', () => {
    expect(bySerial('PK1334PBGXAMLS')).toEqual({
      serial: 'PK1334PBGXAMLS',
      wwn: '0x5000cca23dcce24d',
      model: 'HGST HUS724040ALE640',
      capacityBytes: 4000787030016,
      driveType: 'HDD',
      formFactor: '3.5 inches',
      health: 'ok',
      lastReportedAt: '2026-10-10T00:00:14.000Z',
      state: 'active',
      temperatureC: 42,
      detailUrl: `${BASE}/web/device/0ed2911b-4491-5e37-9a38-52a4628efd65`,
    });
  });

  it('R46: archived entries map to decommissioned with their old collector date', () => {
    const o = bySerial('Z1F4D9P8');
    expect(o.state).toBe('decommissioned');
    expect(o.lastReportedAt).toBe('2026-07-01T00:00:00.000Z');
    expect(bySerial('BTWL342107E8480QGN').state).toBe('decommissioned');
    expect(bySerial('BTWL342107E8480QGN').lastReportedAt).toBe('2026-01-29T15:00:00.000Z');
  });

  it('R59: drive type from rotational speed (0 = SSD, other = HDD) and protocol', () => {
    expect(bySerial('BTWL334003NB480QGN').driveType).toBe('SSD'); // ATA, speed 0
    expect(bySerial('QJL522R0029130S326').driveType).toBe('SSD');
    expect(bySerial('ZGY28D5L').driveType).toBe('HDD'); // 5980 rpm
    expect(bySerial('Z1P3GMFD').driveType).toBe('HDD'); // odd 7202 rpm still HDD
    expect(bySerial('SN195108904754').driveType).toBe('NVMe');
  });

  it('R59: empty form factor is tolerated and omitted', () => {
    const o = bySerial('S1E16KGM');
    expect(o.formFactor).toBeUndefined();
    expect('formFactor' in o).toBe(false);
    expect(bySerial('SN195108904754').formFactor).toBeUndefined();
  });

  it('R58: the empty nvme0 record is unidentified, unknown health, no bogus fields', () => {
    const empty = all.filter((o) => o.serial === undefined);
    expect(empty).toHaveLength(1);
    expect(empty[0]).toEqual({
      driveType: 'NVMe',
      health: 'unknown',
      // no SMART block: falls back to the record's UpdatedAt
      lastReportedAt: '2026-06-25T12:10:48.935Z',
      state: 'active',
      detailUrl: `${BASE}/web/device/4bacc143-98a9-59bf-961f-0d6cba4b5701`,
    });
  });

  it('NVMe whose "WWN" is its lowercase serial: no wwn emitted, serial kept as-is', () => {
    const o = bySerial('SN195108904754');
    expect(o.wwn).toBeUndefined();
    expect('wwn' in o).toBe(false);
    expect(o.model).toBe('GIGABYTE GP-GSM2NE3256GNTD');
    expect(o.capacityBytes).toBe(256060514304);
  });

  it('stale NVMe keeps its old collector date and last known health (R47)', () => {
    const o = bySerial('SN195108904754');
    expect(o.state).toBe('active');
    expect(o.lastReportedAt).toBe('2026-07-01T00:00:00.000Z');
    expect(o.health).toBe('ok');
    expect(o.temperatureC).toBe(31);
  });

  describe('status and risk disagreements (Appendix B)', () => {
    it('status 3 (both bits) with risk healthy -> failed', () => {
      expect(bySerial('BTWL334003NB480QGN').health).toBe('failed');
    });
    it('status 1 (SMART failed), archived, risk healthy -> failed', () => {
      expect(bySerial('BTWL342107E8480QGN').health).toBe('failed');
    });
    it('status 3 with risk monitor -> failed', () => {
      expect(bySerial('Z1P3GMFD').health).toBe('failed');
    });
    it('status 2 (threshold) with risk replace_soon -> failed (risk wins over warning)', () => {
      expect(bySerial('Z1F4D9P8').health).toBe('failed');
    });
    it('status 2 with risk healthy -> warning', () => {
      expect(bySerial('Z1F48YQT').health).toBe('warning');
    });
    it('status 2 with risk plan_replacement -> warning', () => {
      expect(bySerial('PK1331PAJ0JGWX').health).toBe('warning');
    });
    it('status 0 with risk healthy -> ok; NVMe with risk_score 20 -> ok', () => {
      expect(bySerial('ZGY28D5L').health).toBe('ok');
      expect(bySerial('SN195108904754').health).toBe('ok');
    });
  });

  describe('mapHealth table', () => {
    it.each([
      [0, 'healthy', true, 'ok'],
      [0, 'monitor', true, 'ok'],
      [0, 'plan_replacement', true, 'warning'],
      [0, 'replace_soon', true, 'failed'],
      [1, 'healthy', true, 'failed'],
      [2, 'healthy', true, 'warning'],
      [3, undefined, true, 'failed'],
      [0, undefined, false, 'unknown'],
      [0, 'healthy', false, 'unknown'],
    ] as const)('status %s risk %s smart %s -> %s', (status, risk, hasSmart, expected) => {
      expect(mapHealth(status, risk, hasSmart)).toBe(expected);
    });
  });

  it('trims serials and drops blank ones', () => {
    const entry = (serial: string) => ({
      data: {
        summary: {
          a: {
            device: { device_id: 'x', serial_number: serial, device_status: 0 },
            smart: { collector_date: '2026-01-01T00:00:00Z' },
          },
        },
      },
    });
    expect(mapSummary(entry('  AB12  '), BASE)[0]?.serial).toBe('AB12');
    expect(mapSummary(entry('   '), BASE)[0]?.serial).toBeUndefined();
  });

  it('rejects a response that is not a summary', () => {
    expect(() => mapSummary({ nope: 1 }, BASE)).toThrow();
  });
});

describe('Scrutiny config (R45)', () => {
  it('requires SCRUTINY_URL', () => {
    expect(() => loadScrutinyConfig({})).toThrow(/SCRUTINY_URL/);
    expect(() => loadScrutinyConfig({ SCRUTINY_URL: 'not a url' })).toThrow(/SCRUTINY_URL/);
  });
  it('strips trailing slashes and treats an empty token as absent', () => {
    expect(loadScrutinyConfig({ SCRUTINY_URL: 'http://s:8080//', SCRUTINY_TOKEN: '' })).toEqual({
      baseUrl: 'http://s:8080',
    });
    expect(loadScrutinyConfig({ SCRUTINY_URL: 'http://s:8080', SCRUTINY_TOKEN: 't' })).toEqual({
      baseUrl: 'http://s:8080',
      token: 't',
    });
  });
});

describe('Scrutiny adapter fetching', () => {
  afterEach(() => vi.unstubAllGlobals());
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('GETs /api/summary without Authorization when no token is set', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(fixture));
    vi.stubGlobal('fetch', fetchMock);
    const list = await createScrutinyProvider({ SCRUTINY_URL: `${BASE}/` }).fetchSnapshot();
    expect(list).toHaveLength(16);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/summary`);
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends the bearer token when configured', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(fixture));
    vi.stubGlobal('fetch', fetchMock);
    await createScrutinyProvider({ SCRUTINY_URL: BASE, SCRUTINY_TOKEN: 'secret' }).fetchSnapshot();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret');
  });

  it('non-200 rejects fetchSnapshot and checkConnection returns ok:false without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 401)),
    );
    const p = createScrutinyProvider({ SCRUTINY_URL: BASE });
    await expect(p.fetchSnapshot()).rejects.toThrow(/401/);
    const r = await p.checkConnection();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/401/);
  });

  it('network errors and garbage bodies are reported, never thrown, by checkConnection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const p = createScrutinyProvider({ SCRUTINY_URL: BASE });
    expect(await p.checkConnection()).toEqual({ ok: false, error: 'fetch failed' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>', { status: 200 })),
    );
    expect((await p.checkConnection()).ok).toBe(false);
  });

  it('checkConnection is ok on a good response; id and interval declared', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(fixture)),
    );
    const p = createScrutinyProvider({ SCRUTINY_URL: BASE });
    expect(await p.checkConnection()).toEqual({ ok: true });
    expect(p.id).toBe('scrutiny');
    expect(p.expectedUpdateIntervalHours).toBe(24);
  });
});

describe('Scrutiny adapter passes the provider contract (R57)', () => {
  const body = JSON.stringify(fixture);
  const stubOk = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );
  const stubDown = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('connect ECONNREFUSED');
      }),
    );
  beforeEach(stubOk);
  afterEach(() => vi.unstubAllGlobals());
  runProviderContract(
    'scrutiny',
    () => createProvider('scrutiny', { SCRUTINY_URL: BASE }),
    () => {
      stubDown();
      return createProvider('scrutiny', { SCRUTINY_URL: BASE });
    },
  );
});
