import type { Activity, ActivityEvent } from '@sparrow/shared';
import { formatDate } from './format';

export interface PoolHistoryItem {
  id: string;
  /** YYYY-MM-DD: the day the user gave for the activity, else the day it was recorded (local time, D3). */
  date: string;
  /** Sort key: the displayed day, then the log position, so the list matches what it shows (F12). */
  sortKey: number;
  title: string;
  detail: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const roleWord = (role: unknown): string => {
  const r = str(role);
  return r === 'hot-spare' ? 'hot spare' : (r ?? 'member');
};
const FIELD_WORD: Record<string, string> = {
  name: 'name',
  layoutLabel: 'layout label',
  expectedMembers: 'expected members',
};

/** One line per event of an activity that concerns this pool. The member is named from the drive, the bay from the copied label. */
function describeEvent(e: ActivityEvent): { title: string; detail: string | null } {
  const p = e.payload;
  const member = e.drive?.serial ?? 'A drive';
  const label = str(e.slotLabel);
  const grid = str(e.gridName);
  const bay = label && grid ? `${grid}, ${label}` : label;
  switch (e.type) {
    case 'pool-created':
      return { title: 'Pool created', detail: null };
    case 'pool-updated': {
      const changes = typeof p.changes === 'object' && p.changes !== null ? p.changes : {};
      const name = (changes as Record<string, { from?: unknown; to?: unknown }>).name;
      const fields = Object.keys(changes).map((k) => FIELD_WORD[k] ?? k);
      return {
        title: name ? `Renamed from ${String(name.from)} to ${String(name.to)}` : 'Pool updated',
        detail: fields.length > 0 && !name ? fields.join(', ') : null,
      };
    }
    case 'pool-deleted':
      return { title: 'Pool deleted', detail: null };
    // Installing and uninstalling carry the pool as part of the installation (R29, R14).
    case 'drive-installed':
      return {
        title: `${member} installed${bay ? ` in ${bay}` : ''} as ${roleWord(p.poolRole)}`,
        detail: null,
      };
    case 'drive-uninstalled':
      return {
        title: `${member} left${bay ? ` ${bay}` : ''}`,
        detail: roleWord(p.poolRole),
      };
    case 'pool-joined':
      return {
        title: `${member} joined${bay ? ` in ${bay}` : ''} as ${roleWord(p.poolRole)}`,
        detail: null,
      };
    case 'pool-left':
      return {
        title: `${member} left the pool${bay ? ` (${bay})` : ''}`,
        detail: roleWord(p.poolRole),
      };
    case 'pool-role-changed':
      return {
        title: `${member} changed role`,
        detail: `${roleWord(p.from)} → ${roleWord(p.to)}`,
      };
    default:
      return { title: e.type.replace(/-/g, ' '), detail: null };
  }
}

/**
 * The pool's history: one entry per event on this pool, from the activities the API returned (each with
 * all its events). The displayed day is the activity's own (`occurredOn`) else the day it was recorded,
 * and the list is sorted by that displayed day, newest first, ties by log position (F12).
 */
export function poolHistoryItems(activities: Activity[], poolId: string): PoolHistoryItem[] {
  const items: PoolHistoryItem[] = [];
  for (const a of activities) {
    const date = a.occurredOn ?? formatDate(a.recordedAt);
    for (const e of a.events) {
      if (e.poolId !== poolId) continue;
      const { title, detail } = describeEvent(e);
      items.push({
        id: `${a.id}:${e.id}`,
        date,
        sortKey: Date.parse(`${date}T00:00:00.000Z`) * 1000 + a.seq,
        title,
        detail,
      });
    }
  }
  return items.sort((x, y) => y.sortKey - x.sortKey);
}
