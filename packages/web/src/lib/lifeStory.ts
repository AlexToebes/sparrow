import type { DriveEvent } from '@sparrow/shared';
import { formatDuration } from './format';

export interface StoryItem {
  id: string;
  at: string;
  kind: DriveEvent['type'];
  title: string;
  detail: string | null;
  /** Gap since the previous item, "after 28 d", or null for the first one. */
  gap: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function where(p: Record<string, unknown>): string | null {
  const label = str(p.slotLabel);
  const grid = str(p.gridName);
  return label && grid ? `${grid}, ${label}` : (label ?? grid);
}

/** Looks up a pool's name by ID, so the story can say which pool (null when unknown). */
export type PoolNameLookup = (poolId: string) => string | null;

const roleWord = (role: string | null): string | null =>
  role === 'hot-spare' ? 'hot spare' : role;

function describe(
  e: DriveEvent,
  poolName: PoolNameLookup,
): { title: string; detail: string | null } {
  const p = e.payload;
  const pool = () => {
    const id = str(p.poolId);
    return id ? poolName(id) : null;
  };
  const note = str(p.note);
  const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(' · ') || null;
  switch (e.type) {
    case 'drive-created':
      return { title: 'Added to Sparrow', detail: join(str(p.condition), str(p.vendor)) };
    case 'drive-updated':
      return {
        title: 'Details edited',
        detail:
          p.changes && typeof p.changes === 'object' ? Object.keys(p.changes).join(', ') : null,
      };
    case 'drive-installed':
      return { title: `Installed in ${where(p) ?? 'a slot'}`, detail: join(str(p.role), note) };
    case 'drive-removed':
      return { title: `Removed from ${where(p) ?? 'a slot'}`, detail: note };
    case 'drive-retired':
      return {
        title: 'Retired',
        detail: join(str(p.reason), str(p.date), note),
      };
    case 'drive-reinstated':
      return { title: 'Reinstated as a spare', detail: note };
    case 'drive-sent-for-rma':
      return { title: 'Sent for RMA', detail: join(str(p.date), note) };
    case 'drive-linked':
      return { title: 'Linked to a drive in the NAS', detail: str(p.observationSerial) };
    case 'pool-joined':
      return {
        title: pool() ? `Joined pool ${pool()}` : 'Joined a pool',
        detail: roleWord(str(p.role)),
      };
    case 'pool-left':
      return {
        title: pool() ? `Left pool ${pool()}` : 'Left a pool',
        detail: roleWord(str(p.role)),
      };
    case 'pool-role-changed':
      return { title: 'Pool role changed', detail: join(str(p.from), str(p.to)) };
  }
}

/** Events newest first (as the API returns) in, oldest-first story out. */
export function buildStory(
  eventsNewestFirst: DriveEvent[],
  poolName: PoolNameLookup = () => null,
): StoryItem[] {
  const ordered = [...eventsNewestFirst].reverse();
  return ordered.map((e, i) => {
    const prev = ordered[i - 1];
    const ms = prev ? Date.parse(e.at) - Date.parse(prev.at) : 0;
    const { title, detail } = describe(e, poolName);
    return {
      id: e.id,
      at: e.at,
      kind: e.type,
      title,
      detail,
      gap: prev ? (ms < 24 * 3600_000 ? 'same day' : `after ${formatDuration(ms)}`) : null,
    };
  });
}

export interface StorySummary {
  inService: number;
  onShelf: number;
}

/** Time installed and time on the shelf, from the event sequence up to `end` (now, or retirement). */
export function summarizeStory(
  eventsNewestFirst: DriveEvent[],
  now: number = Date.now(),
): StorySummary {
  const ordered = [...eventsNewestFirst].reverse();
  const out: StorySummary = { inService: 0, onShelf: 0 };
  type Phase = 'shelf' | 'installed' | 'retired' | null;
  let state: Phase = null as Phase;
  let since = 0;
  const close = (at: number) => {
    if (state === 'shelf') out.onShelf += at - since;
    if (state === 'installed') out.inService += at - since;
  };
  for (const e of ordered) {
    const at = Date.parse(e.at);
    const next: Phase =
      e.type === 'drive-created' || e.type === 'drive-removed' || e.type === 'drive-reinstated'
        ? 'shelf'
        : e.type === 'drive-installed'
          ? 'installed'
          : e.type === 'drive-retired'
            ? 'retired'
            : state;
    if (next !== state) {
      close(at);
      state = next;
      since = at;
    }
  }
  close(now);
  return out;
}
