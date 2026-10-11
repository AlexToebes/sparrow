import type { DriveEvent, EventDriveRef, EventSlotLink } from '@sparrow/shared';

// Builders for event fixtures in the shape the API returns: one event per action with its links.

let n = 0;

export const drive = (
  driveId: string,
  serial: string,
  role: EventDriveRef['role'] = 'subject',
  capacityBytes: number | null = null,
): EventDriveRef => ({ driveId, role, serial, capacityBytes, driveType: null });

/** A bay link. An empty grid name stands for "no grid known", so the label is shown alone. */
export const bay = (
  slotId: string,
  role: EventSlotLink['role'],
  label: string,
  gridName = '',
): EventSlotLink => ({ slotId, role, slotLabel: label, gridId: 'g1', gridName });

export function makeEvent(
  type: DriveEvent['type'],
  at: string,
  payload: Record<string, unknown> = {},
  links: {
    drives?: EventDriveRef[];
    slots?: EventSlotLink[];
    pools?: { poolId: string; poolName: string }[];
  } = {},
): DriveEvent {
  return {
    id: `e${++n}`,
    type,
    at,
    payload,
    links: {
      drives: links.drives ?? [drive('d1', 'ZL1')],
      slots: links.slots ?? [],
      pools: links.pools ?? [],
    },
  };
}
