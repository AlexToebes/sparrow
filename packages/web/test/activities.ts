import type { Activity, ActivityEvent, ActivityKind, EventType } from '@sparrow/shared';

// Builders for activity fixtures in the shape the API returns: an activity with all its events, each
// event about at most one drive, one bay and one pool (R14).

let n = 0;
let seq = 0;

export interface EventOpts {
  /** [driveId, serial, capacityBytes?] */
  drive?: [string, string, (number | null)?];
  /** [slotId, label, gridName?] */
  slot?: [string, string, string?];
  /** [poolId, poolName] */
  pool?: [string, string];
  payload?: Record<string, unknown>;
}

export function ev(type: EventType, o: EventOpts = {}): ActivityEvent {
  const [driveId, serial, capacityBytes] = o.drive ?? [];
  const [slotId, slotLabel, gridName] = o.slot ?? [];
  const [poolId, poolName] = o.pool ?? [];
  return {
    id: `e${++n}`,
    ord: 0,
    type,
    driveId: driveId ?? null,
    slotId: slotId ?? null,
    slotLabel: slotLabel ?? null,
    gridId: slotId ? 'g1' : null,
    gridName: slotId ? (gridName ?? '') : null,
    poolId: poolId ?? null,
    poolName: poolName ?? null,
    payload: o.payload ?? {},
    drive: driveId
      ? { serial: serial ?? driveId, capacityBytes: capacityBytes ?? null, driveType: null }
      : null,
  };
}

export function act(
  kind: ActivityKind,
  recordedAt: string,
  occurredOn: string | null,
  events: ActivityEvent[],
  extra: { note?: string | null; seq?: number } = {},
): Activity {
  const s = extra.seq ?? ++seq;
  seq = Math.max(seq, s);
  return {
    id: `a${s}-${++n}`,
    seq: s,
    kind,
    recordedAt,
    occurredOn,
    note: extra.note ?? null,
    events: events.map((e, ord) => ({ ...e, ord })),
  };
}
