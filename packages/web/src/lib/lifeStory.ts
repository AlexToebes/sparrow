import type { DriveEvent } from '@sparrow/shared';
import { formatDate, formatDuration } from './format';

export interface StoryItem {
  id: string;
  /** The effective instant (see `effective`), not necessarily when the event was recorded. */
  at: string;
  /** YYYY-MM-DD to show for the entry (the installation date for a backdated install, else local). */
  date: string;
  /** "recorded 2026-10-11" when the entry describes an earlier date than the day it was logged. */
  recorded: string | null;
  kind: DriveEvent['type'];
  title: string;
  detail: string | null;
  /** Gap since the previous item, "after 28 d", or null for the first one. */
  gap: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MIDNIGHT_Z = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/;
const dateStr = (v: unknown): string | null => {
  const s = str(v);
  return s !== null && DATE_ONLY.test(s) ? s : null;
};
const midnight = (date: string) => `${date}T00:00:00.000Z`;

/**
 * R68: the event log records WHEN a change was made (`at`); an installation can describe an earlier
 * day. The story orders by the effective instant: for drive-installed the payload's installedOn
 * (unless it is the very day the event was logged, then `at` keeps same-day order exact), for
 * pool-joined the membership start. Midnight-UTC instants stand for calendar dates (how the server
 * stores a backdated start), so they are shown as the date itself, never shifted by the time zone.
 */
function effective(e: DriveEvent): { at: string; date: string; recorded: string | null } {
  const logged = formatDate(e.at);
  let at = e.at;
  let date = logged;
  if (e.type === 'drive-installed') {
    const on = dateStr(e.payload.installedOn);
    if (on !== null) {
      if (on !== e.at.slice(0, 10)) at = midnight(on);
      date = on;
    }
  } else if (e.type === 'pool-joined') {
    const started = str(e.payload.startedAt);
    if (started !== null && !Number.isNaN(Date.parse(started))) {
      at = started;
      date = MIDNIGHT_Z.test(started) ? started.slice(0, 10) : formatDate(started);
    }
  }
  return { at, date, recorded: date !== logged ? logged : null };
}

/** Oldest first by effective instant. Ties keep the log order, except that joining a pool follows installing. */
function orderedByEffective(eventsNewestFirst: DriveEvent[]) {
  const rank = (e: DriveEvent) => (e.type === 'pool-joined' ? 1 : 0);
  return [...eventsNewestFirst]
    .reverse()
    .map((event) => ({ event, ...effective(event) }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || rank(a.event) - rank(b.event));
}

/** The installation-date change a drive-updated event carries, if any (R68). */
function installedOnChange(e: DriveEvent): { from: string | null; to: string | null } | null {
  const changes = e.payload.changes;
  if (e.type !== 'drive-updated' || typeof changes !== 'object' || changes === null) return null;
  const c = (changes as Record<string, unknown>).installedOn;
  if (typeof c !== 'object' || c === null) return null;
  const { from, to } = c as Record<string, unknown>;
  return { from: dateStr(from), to: dateStr(to) };
}

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
    case 'drive-updated': {
      const others =
        p.changes && typeof p.changes === 'object'
          ? Object.keys(p.changes).filter((k) => k !== 'installedOn')
          : [];
      const date = installedOnChange(e);
      if (date) {
        return {
          title: `Installation date changed from ${date.from ?? 'unknown'} to ${date.to ?? 'unknown'}`,
          detail: others.length > 0 ? `Also edited: ${others.join(', ')}` : null,
        };
      }
      return { title: 'Details edited', detail: others.join(', ') || null };
    }
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
  const ordered = orderedByEffective(eventsNewestFirst);
  return ordered.map((o, i) => {
    const prev = ordered[i - 1];
    const ms = prev ? Date.parse(o.at) - Date.parse(prev.at) : 0;
    const { title, detail } = describe(o.event, poolName);
    return {
      id: o.event.id,
      at: o.at,
      date: o.date,
      recorded: o.recorded,
      kind: o.event.type,
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
  const out: StorySummary = { inService: 0, onShelf: 0 };
  type Phase = 'shelf' | 'installed' | 'retired' | null;
  let state: Phase = null as Phase;
  let since = 0;
  const close = (at: number) => {
    if (state === 'shelf') out.onShelf += Math.max(0, at - since);
    if (state === 'installed') out.inService += Math.max(0, at - since);
  };
  for (const o of orderedByEffective(eventsNewestFirst)) {
    const at = Date.parse(o.at);
    const e = o.event;
    // R68: a drive can be logged here long after it went in, so "added to Sparrow" only starts the
    // shelf phase when nothing earlier is known.
    const next: Phase =
      e.type === 'drive-created'
        ? state === null
          ? 'shelf'
          : state
        : e.type === 'drive-removed' || e.type === 'drive-reinstated'
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
    // Editing the installation date moves the start of the phase that is running.
    const edit = installedOnChange(e);
    if (state === 'installed' && edit?.to) since = Date.parse(midnight(edit.to));
  }
  close(now);
  return out;
}
