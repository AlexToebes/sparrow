import { describe, expect, it } from 'vitest';
import {
  DRIVE_STATUSES,
  driveSchema,
  occupantResolutionSchema,
  retireDriveInputSchema,
  enclosureSchema,
  EVENT_TYPES,
  DRIVE_LINK_ROLES,
  SLOT_LINK_ROLES,
  eventLinksSchema,
  storedEventSchema,
  exportFileSchema,
  EXPORT_SCHEMA_VERSION,
  gridSchema,
  membershipSchema,
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
  status: 'spare',
  slotId: null,
  retirementReason: null,
  retirementDate: null,
  retirementNote: null,
  installedOn: null,
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

describe('pool, membership, event schemas', () => {
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

  const noLinks = { drives: [], slots: [], pools: [] };

  it('R14: every event type of the one-event-per-action model is accepted', () => {
    const e = { id: 'e', type: 'health-changed', at: ts, payload: {}, links: noLinks };
    expect([...EVENT_TYPES]).toEqual(
      expect.arrayContaining([
        'drive-installed',
        'drive-removed',
        'drive-retired',
        'drive-sent-for-rma',
        'drive-reinstated',
        'drive-moved',
        'drives-swapped',
        'drive-replaced',
        'pool-joined',
        'pool-left',
        'pool-role-changed',
        'slot-relabeled',
        'pool-created',
      ]),
    );
    for (const type of EVENT_TYPES) {
      expect(storedEventSchema.safeParse({ ...e, type }).success).toBe(true);
    }
  });

  it('R74: link roles are fixed lists', () => {
    expect([...DRIVE_LINK_ROLES]).toEqual(['subject', 'outgoing', 'incoming']);
    expect([...SLOT_LINK_ROLES]).toEqual(['from', 'to', 'at']);
    const link = { driveId: 'd', role: 'subject' };
    expect(eventLinksSchema.safeParse({ ...noLinks, drives: [link] }).success).toBe(true);
    expect(
      eventLinksSchema.safeParse({ ...noLinks, drives: [{ ...link, role: 'bystander' }] }).success,
    ).toBe(false);
    const slot = { slotId: 's', role: 'at', slotLabel: null, gridId: 'g', gridName: 'Front' };
    expect(eventLinksSchema.safeParse({ ...noLinks, slots: [slot] }).success).toBe(true);
    expect(
      eventLinksSchema.safeParse({ ...noLinks, slots: [{ ...slot, role: 'beside' }] }).success,
    ).toBe(false);
    expect(
      eventLinksSchema.safeParse({ ...noLinks, pools: [{ poolId: 'p', poolName: 'tank' }] })
        .success,
    ).toBe(true);
  });

  it('R29: membership validates role and end not before start', () => {
    const m = {
      id: 'm',
      driveId: 'd',
      poolId: 'p',
      role: 'data',
      source: 'manual',
      startedAt: ts,
      endedAt: null,
      createdAt: ts,
    };
    expect(membershipSchema.safeParse(m).success).toBe(true);
    expect(membershipSchema.safeParse({ ...m, role: 'cache' }).success).toBe(false);
    expect(membershipSchema.safeParse({ ...m, endedAt: '2025-01-01T00:00:00Z' }).success).toBe(
      false,
    );
  });

  it('R14: a stored event accepts a payload object and rejects an unknown type or missing links', () => {
    const e = { id: 'e', type: 'drive-created', at: ts, payload: { a: 1 }, links: noLinks };
    expect(storedEventSchema.safeParse(e).success).toBe(true);
    expect(storedEventSchema.safeParse({ ...e, type: 'drive-exploded' }).success).toBe(false);
    expect(storedEventSchema.safeParse({ ...e, payload: 'x' }).success).toBe(false);
    expect(storedEventSchema.safeParse({ ...e, links: undefined }).success).toBe(false);
    // The old single-drive shape is gone.
    expect(storedEventSchema.safeParse({ ...e, driveId: 'd' }).success).toBe(true); // extra keys are ignored
  });

  it('R41, R42: the export is schema version 2 and carries event links', () => {
    expect(EXPORT_SCHEMA_VERSION).toBe(2);
    const file = {
      format: 'sparrow-export',
      schemaVersion: 2,
      exportedAt: ts,
      data: {
        enclosures: [],
        grids: [],
        slots: [],
        drives: [],
        pools: [],
        memberships: [],
        events: [
          {
            id: 'e',
            type: 'pool-created',
            at: ts,
            payload: {},
            links: { ...noLinks, pools: [{ poolId: 'p', poolName: 'tank' }] },
          },
        ],
        appMeta: [],
      },
    };
    expect(exportFileSchema.safeParse(file).success).toBe(true);
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
