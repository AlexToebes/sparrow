import type { DriveEvent } from '@sparrow/shared';
import { formatDate } from './format';

export interface PoolHistoryItem {
  id: string;
  /** YYYY-MM-DD in the browser's local time (D3), or the date the user gave for a joined / left. */
  date: string;
  title: string;
  detail: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const roleWord = (role: string | null): string =>
  role === 'hot-spare' ? 'hot spare' : (role ?? 'member');
const FIELD_WORD: Record<string, string> = {
  name: 'name',
  layoutLabel: 'layout label',
  expectedMembers: 'expected members',
};
const MIDNIGHT_Z = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/;

/** A user-supplied membership start / end shows as typed; otherwise the event's own time. */
function dateOf(e: DriveEvent): string {
  const given = str(e.type === 'pool-left' ? e.payload.endedAt : e.payload.startedAt);
  if (given !== null && !Number.isNaN(Date.parse(given))) {
    return MIDNIGHT_Z.test(given) ? given.slice(0, 10) : formatDate(given);
  }
  return formatDate(e.at);
}

/** One line per event linked to a pool. The member is named from the drive link, the pool from the copied name. */
export function describePoolEvent(e: DriveEvent): PoolHistoryItem {
  const p = e.payload;
  const member = e.links.drives[0]?.serial ?? 'A drive';
  const base = { id: e.id, date: dateOf(e) };
  switch (e.type) {
    case 'pool-created':
      return { ...base, title: 'Pool created', detail: null };
    case 'pool-updated': {
      const changes = typeof p.changes === 'object' && p.changes !== null ? p.changes : {};
      const name = (changes as Record<string, { from?: unknown; to?: unknown }>).name;
      const fields = Object.keys(changes).map((k) => FIELD_WORD[k] ?? k);
      return {
        ...base,
        title: name ? `Renamed from ${String(name.from)} to ${String(name.to)}` : 'Pool updated',
        detail: fields.length > 0 && !name ? fields.join(', ') : null,
      };
    }
    case 'pool-deleted':
      return { ...base, title: 'Pool deleted', detail: null };
    case 'pool-joined':
      return { ...base, title: `${member} joined as ${roleWord(str(p.role))}`, detail: null };
    case 'pool-left':
      return { ...base, title: `${member} left`, detail: roleWord(str(p.role)) };
    case 'pool-role-changed':
      return {
        ...base,
        title: `${member} changed role`,
        detail: `${roleWord(str(p.from))} → ${roleWord(str(p.to))}`,
      };
    default:
      return { ...base, title: e.type.replace(/-/g, ' '), detail: null };
  }
}
