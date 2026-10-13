import { setupInputSchema } from '@sparrow/shared';
import { completeSetup } from '../src/core/setup.js';
import type { AppDb } from '../src/db/client.js';

/**
 * The layout the app used to seed at first start (before R5 changed, 2026-10-13): NAS with "Front
 * bays" (4 x 2, labels 1 to 8), "Internal SSDs" (Left, Right) and "Boot" (NVMe). Many tests assume
 * these bays, so they create them explicitly through the setup service. One `layout-updated` activity.
 */
export function createOldLayout(db: AppDb): void {
  completeSetup(
    db,
    setupInputSchema.parse({
      enclosureName: 'NAS',
      grids: [
        {
          name: 'Front bays',
          rows: 2,
          columns: 4,
          orientation: 'landscape',
          labels: ['1', '2', '3', '4', '5', '6', '7', '8'],
        },
        {
          name: 'Internal SSDs',
          rows: 1,
          columns: 2,
          orientation: 'landscape',
          labels: ['Left', 'Right'],
        },
        { name: 'Boot', rows: 1, columns: 1, orientation: 'landscape', labels: ['NVMe'] },
      ],
    }),
  );
}
