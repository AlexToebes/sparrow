import { describe, expect, it } from 'vitest';
import {
  DRIVE_STATUSES,
  driveSchema,
  occupantResolutionSchema,
  retireDriveInputSchema,
  enclosureSchema,
  ACTIVITY_KINDS,
  EVENT_TYPES,
  activitySchema,
  installationSchema,
  storedActivitySchema,
  storedDriveSchema,
  storedEventSchema,
  exportFileSchema,
  EXPORT_SCHEMA_VERSION,
  gridSchema,
  normalizeSerial,
  observationSchema,
  createPoolInputSchema,
  poolSchema,
  slotSchema,
  updatePoolInputSchema,
} from '../src/index.js';

const ts = '2026-01-02T03:04:05Z';
const stamps = { createdAt: ts, updatedAt: ts };

const drive = {
  id: 'd1',
  serial: 'ABC123',
  serialNormalized: 'ABC123',
  wwn: null,
  model: null,
  capacityBytes: 8_000_000_000_000,
  driveType: 'HDD',
  formFactor: null,
  storageLocation: null,
  condition: null,
  lastTestDate: null,
  purchaseDate: '2025-05-06',
  warrantyExpiry: null,
  vendor: null,
  notes: null,
  retirementReason: null,
  retirementDate: null,
  retirementNote: null,
  // Computed from the installation (R13, D7): a spare has none.
  status: 'spare',
  slotId: null,
  installedOn: null,
  poolId: null,
  poolRole: null,
  ...stamps,
};

describe('normalizeSerial', () => {
  it('R26, D6: trims and ignores case', () => {
    expect(normalizeSerial('  ab-12 c\t')).toBe('AB-12 C');
    expect(normalizeSerial('abc')).toBe(normalizeSerial('ABC'));
  });
});

describe('layout schemas', () => {
  it('R39: enclosure, grid and slot accept valid records', () => {
    expect(enclosureSchema.safeParse({ id: 'e', name: 'NAS', ...stamps }).success).toBe(true);
    const grid = {
      id: 'g',
      enclosureId: 'e',
      name: 'Front',
      rows: 2,
      columns: 4,
      orientation: 'landscape',
      ...stamps,
    };
    expect(gridSchema.safeParse(grid).success).toBe(true);
    expect(
      slotSchema.safeParse({ id: 's', gridId: 'g', position: 0, label: null, ...stamps }).success,
    ).toBe(true);
  });

  it('R4, R7: rejects empty name, zero rows and bad orientation', () => {
    expect(enclosureSchema.safeParse({ id: 'e', name: '', ...stamps }).success).toBe(false);
    const grid = {
      id: 'g',
      enclosureId: 'e',
      name: 'Front',
      rows: 2,
      columns: 4,
      orientation: 'landscape',
      ...stamps,
    };
    expect(gridSchema.safeParse({ ...grid, rows: 0 }).success).toBe(false);
    expect(gridSchema.safeParse({ ...grid, orientation: 'diagonal' }).success).toBe(false);
  });

  it('R39: rejects negative slot position', () => {
    expect(
      slotSchema.safeParse({ id: 's', gridId: 'g', position: -1, label: null, ...stamps }).success,
    ).toBe(false);
  });
});

describe('driveSchema', () => {
  it('R11, R13: accepts a spare', () => {
    expect(driveSchema.safeParse(drive).success).toBe(true);
    expect(DRIVE_STATUSES).toEqual(['spare', 'installed', 'retired']);
  });

  it('R11: rejects bad enum and bad date format', () => {
    expect(driveSchema.safeParse({ ...drive, driveType: 'Tape' }).success).toBe(false);
    expect(driveSchema.safeParse({ ...drive, purchaseDate: '06/05/2025' }).success).toBe(false);
    expect(driveSchema.safeParse({ ...drive, createdAt: '2026-01-02' }).success).toBe(false);
  });

  it('D7: installed requires a slot, and slot only when installed', () => {
    const installed = { ...drive, status: 'installed', installedOn: '2026-01-02' };
    expect(driveSchema.safeParse(installed).success).toBe(false);
    expect(driveSchema.safeParse({ ...installed, slotId: 's1' }).success).toBe(true);
    expect(driveSchema.safeParse({ ...drive, slotId: 's1' }).success).toBe(false);
  });

  it('R29: pool and role are set together and only on an installed drive', () => {
    const installed = { ...drive, status: 'installed', slotId: 's1' };
    expect(driveSchema.safeParse({ ...installed, poolId: 'p', poolRole: 'data' }).success).toBe(
      true,
    );
    expect(driveSchema.safeParse({ ...installed, poolId: 'p' }).success).toBe(false);
    expect(driveSchema.safeParse({ ...drive, poolId: 'p', poolRole: 'data' }).success).toBe(false);
  });

  it('R41: the stored drive has no status, bay or pool; the retirement date and note need a reason', () => {
    const { status, slotId, installedOn, poolId, poolRole, ...stored } = drive;
    void [status, slotId, installedOn, poolId, poolRole];
    expect(storedDriveSchema.safeParse(stored).success).toBe(true);
    expect(Object.keys(storedDriveSchema.parse(stored))).not.toContain('slotId');
    expect(storedDriveSchema.safeParse({ ...stored, retirementNote: 'x' }).success).toBe(false);
    expect(storedDriveSchema.safeParse({ ...stored, retirementDate: '2026-03-04' }).success).toBe(
      false,
    );
    expect(
      storedDriveSchema.safeParse({ ...stored, retirementReason: 'failed', retirementNote: 'x' })
        .success,
    ).toBe(true);
  });

  it('R68: installedOn is a date or null (not recorded) when installed, and only allowed then', () => {
    const installed = { ...drive, status: 'installed', slotId: 's1' };
    expect(driveSchema.safeParse({ ...installed, installedOn: null }).success).toBe(true);
    expect(driveSchema.safeParse({ ...installed, installedOn: '2024-02-29' }).success).toBe(true);
    expect(driveSchema.safeParse({ ...installed, installedOn: '29/02/2024' }).success).toBe(false);
    expect(driveSchema.safeParse({ ...drive, installedOn: '2024-02-29' }).success).toBe(false);
  });

  it('R60: retired requires a reason; the date is optional (null = not recorded)', () => {
    const retired = { ...drive, status: 'retired' };
    expect(driveSchema.safeParse(retired).success).toBe(false);
    expect(driveSchema.safeParse({ ...retired, retirementDate: '2026-03-04' }).success).toBe(false);
    expect(
      driveSchema.safeParse({ ...retired, retirementReason: 'failed', retirementDate: null })
        .success,
    ).toBe(true);
    expect(
      driveSchema.safeParse({
        ...retired,
        retirementReason: 'failed',
        retirementDate: '2026-03-04',
      }).success,
    ).toBe(true);
  });

  it('R60: the retire and occupant inputs no longer take a replaced-by drive', () => {
    expect(retireDriveInputSchema.safeParse({ reason: 'failed' }).success).toBe(true);
    expect(
      retireDriveInputSchema.safeParse({ reason: 'failed', replacedByDriveId: 'd2' }).success,
    ).toBe(false);
    expect(
      occupantResolutionSchema.safeParse({
        action: 'retire',
        reason: 'failed',
        replacedByDriveId: 'd2',
      }).success,
    ).toBe(false);
    expect(occupantResolutionSchema.safeParse({ action: 'retire' }).success).toBe(false);
  });
});

describe('pool, installation, activity schemas', () => {
  it('R30: pool accepts valid and rejects empty name', () => {
    const pool = { id: 'p', name: 'tank', layoutLabel: 'raidz2', expectedMembers: null, ...stamps };
    expect(poolSchema.safeParse(pool).success).toBe(true);
    expect(poolSchema.safeParse({ ...pool, name: '' }).success).toBe(false);
  });

  it('R72: pool expectedMembers accepts null or 1-100 and rejects 0 and 101', () => {
    const pool = { id: 'p', name: 'tank', layoutLabel: null, expectedMembers: 6, ...stamps };
    expect(poolSchema.safeParse(pool).success).toBe(true);
    expect(poolSchema.safeParse({ ...pool, expectedMembers: null }).success).toBe(true);
    expect(poolSchema.safeParse({ ...pool, expectedMembers: 0 }).success).toBe(false);
    expect(poolSchema.safeParse({ ...pool, expectedMembers: 101 }).success).toBe(false);
    expect(poolSchema.safeParse({ ...pool, expectedMembers: 2.5 }).success).toBe(false);
  });

  it('R72: pool API inputs take optional expectedMembers', () => {
    expect(createPoolInputSchema.parse({ name: 'tank', expectedMembers: 6 }).expectedMembers).toBe(
      6,
    );
    expect(createPoolInputSchema.parse({ name: 'tank' }).expectedMembers).toBeUndefined();
    expect(createPoolInputSchema.safeParse({ name: 'tank', expectedMembers: 0 }).success).toBe(
      false,
    );
    expect(updatePoolInputSchema.safeParse({ expectedMembers: null }).success).toBe(true);
    expect(updatePoolInputSchema.safeParse({ expectedMembers: 101 }).success).toBe(false);
  });

  const event = {
    id: 'e',
    ord: 0,
    type: 'drive-installed',
    driveId: 'd',
    slotId: 's',
    slotLabel: 'Bay 1',
    gridId: 'g',
    gridName: 'Front',
    poolId: 'p',
    poolName: 'tank',
    payload: { poolRole: 'data' },
  };
  const activity = {
    id: 'a',
    seq: 1,
    kind: 'assigned',
    recordedAt: ts,
    occurredOn: '2026-01-02',
    note: null,
    events: [event],
  };

  it('R14: the event types and activity kinds are the atomic model, with no pair-patterns', () => {
    expect([...EVENT_TYPES]).toEqual(
      expect.arrayContaining([
        'drive-installed',
        'drive-uninstalled',
        'installation-updated',
        'drive-retired',
        'drive-sent-for-rma',
        'drive-reinstated',
        'pool-joined',
        'pool-left',
        'pool-role-changed',
        'slot-relabeled',
        'pool-created',
      ]),
    );
    for (const gone of ['drive-removed', 'drive-moved', 'drives-swapped', 'drive-replaced']) {
      expect(EVENT_TYPES as readonly string[]).not.toContain(gone);
    }
    expect([...ACTIVITY_KINDS]).toEqual(
      expect.arrayContaining([
        'assigned',
        'replaced',
        'moved',
        'swapped',
        'pool-changed',
        'health-polled',
        'layout-updated',
      ]),
    );
    for (const type of EVENT_TYPES) {
      expect(storedEventSchema.safeParse({ ...event, type }).success).toBe(true);
    }
  });

  it('R29, D7: an installation sets pool and role together', () => {
    const i = {
      driveId: 'd',
      slotId: 's',
      poolId: 'p',
      poolRole: 'data',
      installedOn: null,
    };
    expect(installationSchema.safeParse(i).success).toBe(true);
    expect(installationSchema.safeParse({ ...i, poolId: null, poolRole: null }).success).toBe(true);
    expect(installationSchema.safeParse({ ...i, poolRole: null }).success).toBe(false);
    expect(installationSchema.safeParse({ ...i, poolRole: 'cache' }).success).toBe(false);
    expect(installationSchema.safeParse({ ...i, installedOn: '29/02/2024' }).success).toBe(false);
  });

  it('R14: an event concerns one drive, one bay and one pool, all optional, with snapshots', () => {
    expect(storedEventSchema.safeParse(event).success).toBe(true);
    const bare = { ...event, driveId: null, slotId: null, slotLabel: null, poolId: null };
    expect(
      storedEventSchema.safeParse({ ...bare, gridId: null, gridName: null, poolName: null }),
    ).toMatchObject({ success: true });
    expect(storedEventSchema.safeParse({ ...event, type: 'drive-exploded' }).success).toBe(false);
    expect(storedEventSchema.safeParse({ ...event, payload: 'x' }).success).toBe(false);
  });

  it('R14: an activity has a kind, a seq, an optional date and its events; the API adds the drive', () => {
    expect(storedActivitySchema.safeParse(activity).success).toBe(true);
    expect(storedActivitySchema.safeParse({ ...activity, kind: 'exploded' }).success).toBe(false);
    expect(storedActivitySchema.safeParse({ ...activity, seq: 0 }).success).toBe(false);
    expect(storedActivitySchema.safeParse({ ...activity, occurredOn: null }).success).toBe(true);
    expect(storedActivitySchema.safeParse({ ...activity, occurredOn: '02/01/2026' }).success).toBe(
      false,
    );
    const api = {
      ...activity,
      events: [{ ...event, drive: { serial: 'ZL1', capacityBytes: null, driveType: null } }],
    };
    expect(activitySchema.safeParse(api).success).toBe(true);
    expect(activitySchema.safeParse(activity).success).toBe(false);
  });

  it('R41, R42: the export is schema version 3 and carries installations and activities', () => {
    expect(EXPORT_SCHEMA_VERSION).toBe(3);
    const file = {
      format: 'sparrow-export',
      schemaVersion: 3,
      exportedAt: ts,
      data: {
        enclosures: [],
        grids: [],
        slots: [],
        drives: [],
        installations: [],
        pools: [],
        activities: [activity],
        appMeta: [],
      },
    };
    expect(exportFileSchema.safeParse(file).success).toBe(true);
    expect(exportFileSchema.safeParse({ ...file, schemaVersion: 2 }).success).toBe(false);
    expect(exportFileSchema.safeParse({ ...file, schemaVersion: 1 }).success).toBe(false);
  });
});

describe('observationSchema', () => {
  const obs = { health: 'ok', lastReportedAt: ts, state: 'active' };

  it('R49, R58: valid without a serial (unidentified)', () => {
    expect(observationSchema.safeParse(obs).success).toBe(true);
    expect(observationSchema.safeParse({ ...obs, serial: 'X1', driveType: 'NVMe' }).success).toBe(
      true,
    );
  });

  it('R49: health is required and must be a known value', () => {
    expect(observationSchema.safeParse({ lastReportedAt: ts, state: 'active' }).success).toBe(
      false,
    );
    expect(observationSchema.safeParse({ ...obs, health: 'critical' }).success).toBe(false);
  });
});
