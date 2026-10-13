import { randomUUID } from 'node:crypto';
import type { ParsedSetupInput, SetupResult, SetupState } from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import * as repo from '../db/layout-repo.js';
import { pools } from '../db/schema.js';
import { recordActivity, type EventInput } from './activities.js';
import { conflict } from './errors.js';
import { gridPayload, makeEnclosure, makeGrid, makeSlots, positionsUpTo } from './layout.js';

// First-run setup wizard (R77, replaces the R5 seed layout). The only state is the app_meta flag
// `setup` ("done" or "skipped"); a database that already has an enclosure counts as set up.

export const SETUP_KEY = 'setup';

export function getSetupState(db: AppDb): SetupState {
  return db.transaction((tx) => {
    const flag = repo.getMeta(tx, SETUP_KEY);
    if (flag === 'done' || flag === 'skipped') return flag;
    return repo.selectEnclosures(tx).length > 0 ? 'done' : 'needed';
  });
}

/** "Skip, I'll set it up later": remembers the choice. Refused once an enclosure exists. */
export function skipSetup(db: AppDb): void {
  db.transaction((tx) => {
    if (repo.selectEnclosures(tx).length > 0) {
      throw conflict('Setup is not available: this Sparrow already has an enclosure');
    }
    repo.setMeta(tx, SETUP_KEY, 'skipped');
  });
}

/**
 * Creates the enclosure, its grids with slots and labels, and the pools in ONE transaction and ONE
 * `layout-updated` activity (R14, R75, R77): enclosure-created, a grid-created per grid (with its
 * slots), a pool-created per pool. Any failure leaves nothing behind. Refused (409) when an
 * enclosure already exists.
 */
export function completeSetup(db: AppDb, input: ParsedSetupInput): SetupResult {
  return db.transaction((tx) => {
    if (repo.selectEnclosures(tx).length > 0) {
      throw conflict('Setup is not available: this Sparrow already has an enclosure');
    }
    const enclosure = makeEnclosure(input.enclosureName);
    repo.insertEnclosure(tx, enclosure);
    const events: EventInput[] = [{ type: 'enclosure-created', payload: { ...enclosure } }];

    const gridIds: string[] = [];
    for (const spec of input.grids) {
      const grid = makeGrid(enclosure.id, {
        name: spec.name,
        rows: spec.rows,
        columns: spec.columns,
        orientation: spec.orientation,
      });
      repo.insertGrid(tx, grid);
      const slotRows = makeSlots(grid.id, positionsUpTo(grid.rows * grid.columns), spec.labels);
      repo.insertSlots(tx, slotRows);
      events.push({ type: 'grid-created', payload: gridPayload(grid, slotRows) });
      gridIds.push(grid.id);
    }

    const at = new Date().toISOString();
    const poolIds: string[] = [];
    for (const spec of input.pools) {
      const row = tx
        .insert(pools)
        .values({
          id: randomUUID(),
          name: spec.name,
          layoutLabel: spec.layoutLabel ?? null,
          expectedMembers: spec.expectedMembers ?? null,
          createdAt: at,
          updatedAt: at,
        })
        .returning()
        .get();
      events.push({ type: 'pool-created', poolId: row.id, payload: { ...row } });
      poolIds.push(row.id);
    }

    recordActivity(tx, { kind: 'layout-updated', events });
    repo.setMeta(tx, SETUP_KEY, 'done');
    return { enclosureId: enclosure.id, gridIds, poolIds };
  });
}
