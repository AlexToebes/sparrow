import type { DriveEvent, EventDriveLink, EventSlotLink } from '@sparrow/shared';

// Compact views of an event's links for assertions, sorted so the expectations don't depend on
// the order the links were written in.

/** `{ driveId, role }` of every drive link, sorted by role then id. */
export const driveLinks = (e: DriveEvent): EventDriveLink[] =>
  e.links.drives
    .map(({ driveId, role }) => ({ driveId, role }))
    .sort((a, b) => a.role.localeCompare(b.role) || a.driveId.localeCompare(b.driveId));

/** `{ slotId, role }` of every slot link, sorted by role then id. */
export const slotLinks = (e: DriveEvent): Pick<EventSlotLink, 'slotId' | 'role'>[] =>
  e.links.slots
    .map(({ slotId, role }) => ({ slotId, role }))
    .sort((a, b) => a.role.localeCompare(b.role) || a.slotId.localeCompare(b.slotId));

/** Pool ids of every pool link, sorted. */
export const poolLinks = (e: DriveEvent): string[] => e.links.pools.map((p) => p.poolId).sort();

/** `[{ driveId, role: 'subject' }]` for the common single-drive event. */
export const subject = (driveId: string): EventDriveLink[] => [{ driveId, role: 'subject' }];
