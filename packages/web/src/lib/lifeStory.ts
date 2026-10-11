import type { DriveEvent, EventDriveRef, EventSlotLink, Health } from '@sparrow/shared';
import { formatBytes, formatDate, formatDuration } from './format';
import { FIELD_LABEL, formatSuggestionValue } from './suggestions';

export interface StoryItem {
  id: string;
  /** The effective instant (see `effective`), not necessarily when the event was recorded. */
  at: string;
  /** YYYY-MM-DD to show for the entry (the installation date for a backdated install, else local). */
  date: string;
  /** "recorded 2026-10-11" when the entry describes an earlier date than the day it was logged. */
  recorded: string | null;
  /** R68: an install whose date is unknown; `date` is then the day it was logged ("recorded"). */
  unrecorded: boolean;
  /** R69: a removal whose date is unknown; `date` is then the day it was logged ("recorded"). */
  removalUnrecorded: boolean;
  /** R60: a retirement or RMA whose date is unknown; `date` is then the day it was logged ("recorded"). */
  retirementUnrecorded: boolean;
  kind: DriveEvent['type'];
  /** The bay a plain install / removal entry is about, so the story can link to its history (R74). */
  slot: { id: string; label: string } | null;
  /** R20: set on health-changed entries, so the view can add the icon and colour for `to`. */
  health: { from: Health | null; to: Health } | null;
  title: string;
  detail: string | null;
  /** Gap since the previous item, "after 28 d", or null for the first one. */
  gap: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MIDNIGHT_Z = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/;
const dateStr = (v: unknown): string | null => {
  const s = str(v);
  return s !== null && DATE_ONLY.test(s) ? s : null;
};
const midnight = (date: string) => `${date}T00:00:00.000Z`;

// One event stands for one real action and links every drive, bay and pool it involves. The story
// of one drive reads the event from that drive's side: its role (subject / outgoing / incoming)
// decides the wording, and the other drive's serial and size come from the links.

const slotLink = (e: DriveEvent, role: EventSlotLink['role']): EventSlotLink | undefined =>
  e.links.slots.find((s) => s.role === role);
const driveRef = (e: DriveEvent, role: EventDriveRef['role']): EventDriveRef | undefined =>
  e.links.drives.find((d) => d.role === role);
const roleOf = (e: DriveEvent, driveId: string): EventDriveRef['role'] | null =>
  e.links.drives.find((d) => d.driveId === driveId)?.role ?? null;

/** "ZL2SPR01 (8 TB)" for another drive named in an event. */
function driveText(ref: EventDriveRef | undefined): string {
  if (!ref) return 'another drive';
  const size = formatBytes(ref.capacityBytes);
  return size ? `${ref.serial} (${size})` : ref.serial;
}

/** What became of a drive that a replacement displaced (drive-replaced, payload.outgoing). */
function outgoingOf(e: DriveEvent): {
  outcome: string | null;
  date: string | null;
  hasDate: boolean;
  reason: string | null;
} {
  const o = rec(e.payload.outgoing);
  return {
    outcome: str(o.outcome),
    date: str(o.date),
    hasDate: 'date' in o,
    reason: str(o.reason),
  };
}

/** The payload date this event gives for the drive on the viewed side; `has` is false when the key is absent (older events). */
function dateOf(e: DriveEvent, driveId: string): { has: boolean; value: string | null } {
  const key = (k: string, from: Record<string, unknown> = e.payload) => ({
    has: k in from,
    value: str(from[k]),
  });
  switch (e.type) {
    case 'drive-installed':
      return key('installedOn');
    case 'drive-removed':
      return key('removedOn');
    case 'drive-retired':
    case 'drive-sent-for-rma':
    case 'drive-moved':
    case 'drives-swapped':
      return key('date');
    case 'drive-replaced':
      return roleOf(e, driveId) === 'outgoing'
        ? key('date', rec(e.payload.outgoing))
        : key('installedOn');
    default:
      return { has: false, value: null };
  }
}

/** True for events that put this drive into a bay (a move also takes it out of another one). */
function arrives(e: DriveEvent, driveId: string): boolean {
  if (e.type === 'drive-installed' || e.type === 'drive-moved' || e.type === 'drives-swapped') {
    return true;
  }
  if (e.type !== 'drive-replaced') return false;
  return roleOf(e, driveId) === 'incoming' || outgoingOf(e).outcome === 'moved';
}

/** How the drive left the shelf-or-bay: back to the spares, retired / RMA, or on to another bay. */
type Exit = 'spares' | 'retired' | 'moved' | null;
function exitOf(e: DriveEvent, driveId: string): Exit {
  switch (e.type) {
    case 'drive-removed':
      return 'spares';
    case 'drive-retired':
    case 'drive-sent-for-rma':
      return 'retired';
    case 'drive-moved':
    case 'drives-swapped':
      return 'moved';
    case 'drive-replaced': {
      if (roleOf(e, driveId) !== 'outgoing') return null;
      const o = outgoingOf(e).outcome;
      return o === 'retired' || o === 'rma' ? 'retired' : o === 'moved' ? 'moved' : 'spares';
    }
    default:
      return null;
  }
}

/** R68: the installation date was not recorded (explicit null) for a drive arriving in a bay. */
const isUnrecordedInstall = (e: DriveEvent, driveId: string): boolean => {
  const d = dateOf(e, driveId);
  return arrives(e, driveId) && d.has && d.value === null;
};

/** R69: the removal date was not recorded for a drive going back to the spares. */
const isUnrecordedRemoval = (e: DriveEvent, driveId: string): boolean => {
  const d = dateOf(e, driveId);
  return exitOf(e, driveId) === 'spares' && d.has && d.value === null;
};

/** R60: the retirement or RMA date was not recorded. */
const isUnrecordedRetirement = (e: DriveEvent, driveId: string): boolean => {
  const d = dateOf(e, driveId);
  return exitOf(e, driveId) === 'retired' && d.has && d.value === null;
};

/**
 * R68, R69, R60: the event log records WHEN a change was made (`at`); an installation can describe an
 * earlier day. The story orders by the effective instant: the installation, removal, move or
 * retirement date in the payload (unless it is the very day the event was logged, then `at` keeps
 * same-day order exact), for pool-joined the membership start, for health-changed the report time.
 * Midnight-UTC instants stand for calendar dates (how the server stores a backdated start), so they
 * are shown as the date itself, never shifted by the time zone. A missing or null date keeps the
 * logging time.
 */
function effective(
  e: DriveEvent,
  driveId: string,
): { at: string; date: string; recorded: string | null } {
  const logged = formatDate(e.at);
  let at = e.at;
  let date = logged;
  const on = dateStr(dateOf(e, driveId).value);
  if (on !== null) {
    if (on !== e.at.slice(0, 10)) at = midnight(on);
    date = on;
  } else if (e.type === 'health-changed') {
    // R20: the event is logged at poll time; the story places it when the provider reported it.
    const reported = str(e.payload.reportedAt);
    if (reported !== null && !Number.isNaN(Date.parse(reported))) {
      at = reported;
      date = formatDate(reported);
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
function orderedByEffective(eventsNewestFirst: DriveEvent[], driveId: string) {
  const rank = (e: DriveEvent) => (e.type === 'pool-joined' ? 1 : 0);
  return [...eventsNewestFirst]
    .reverse()
    .map((event) => ({ event, ...effective(event, driveId) }))
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

const dateOrNotRecorded = (v: string | null) => v ?? 'not recorded';

/** "Front bays, Bay 3" from the bay as the event copied it (stable after renames, R39). */
function where(link: EventSlotLink | undefined): string | null {
  if (!link) return null;
  const label = str(link.slotLabel);
  const grid = str(link.gridName);
  return label && grid ? `${grid}, ${label}` : (label ?? grid);
}

/** "Bay 3" when both bays are in the same grid, else "Front bays, Bay 3". */
function moveWhere(
  from: EventSlotLink | undefined,
  to: EventSlotLink | undefined,
  end: 'from' | 'to',
): string {
  const link = end === 'from' ? from : to;
  const sameGrid = from !== undefined && to !== undefined && from.gridName === to.gridName;
  return (sameGrid ? str(link?.slotLabel) : where(link)) ?? where(link) ?? 'a slot';
}

/** The bay a story entry is about, so it can link to the bay's history (R74). */
function slotOf(e: DriveEvent): StoryItem['slot'] {
  const link =
    e.type === 'drive-installed'
      ? slotLink(e, 'to')
      : e.type === 'drive-removed' || e.type === 'drive-retired' || e.type === 'drive-sent-for-rma'
        ? slotLink(e, 'from')
        : e.type === 'drive-replaced'
          ? slotLink(e, 'at')
          : undefined;
  return link ? { id: link.slotId, label: str(link.slotLabel) ?? 'this slot' } : null;
}

const HEALTH_SHORT: Record<Health, string> = {
  ok: 'OK',
  warning: 'Warning',
  failed: 'Failed',
  unknown: 'Unknown',
};
const HEALTH_VALUES = new Set<string>(Object.keys(HEALTH_SHORT));
const healthOf = (v: unknown): Health | null =>
  typeof v === 'string' && HEALTH_VALUES.has(v) ? (v as Health) : null;

/** R20: the from/to of a health-changed event, or null when it is not one (or is malformed). */
function healthChange(e: DriveEvent): { from: Health | null; to: Health } | null {
  if (e.type !== 'health-changed') return null;
  const to = healthOf(e.payload.to);
  return to === null ? null : { from: healthOf(e.payload.from), to };
}

const roleWord = (role: string | null): string | null =>
  role === 'hot-spare' ? 'hot spare' : role;

/** What became of the displaced drive, in words: "back to spares", "retired (failed)", "moved to Bay 7". */
function outcomeText(e: DriveEvent): string {
  const o = outgoingOf(e);
  switch (o.outcome) {
    case 'retired':
      return o.reason ? `retired (${o.reason})` : 'retired';
    case 'rma':
      return 'sent for RMA';
    case 'moved': {
      const to = slotLink(e, 'to');
      return to ? `moved to ${where(to)}` : 'moved to another bay';
    }
    default:
      return 'back to spares';
  }
}

function describe(e: DriveEvent, driveId: string): { title: string; detail: string | null } {
  const p = e.payload;
  const poolName = e.links.pools[0]?.poolName ?? null;
  const note = str(p.note);
  const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(' · ') || null;
  const unrecInstall = isUnrecordedInstall(e, driveId);
  switch (e.type) {
    case 'drive-created':
      return { title: 'Added to Sparrow', detail: join(str(p.condition), str(p.vendor)) };
    case 'drive-updated': {
      const others =
        p.changes && typeof p.changes === 'object'
          ? Object.keys(p.changes).filter((k) => k !== 'installedOn')
          : [];
      if (p.source === 'provider') {
        // R72: edits the owner accepted from provider suggestions; our labels, never provider names.
        const names = others.map(
          (k) => FIELD_LABEL[k as keyof typeof FIELD_LABEL]?.toLowerCase() ?? k,
        );
        return {
          title: `Details updated from the provider${names.length > 0 ? `: ${names.join(', ')}` : ''}`,
          detail: null,
        };
      }
      const date = installedOnChange(e);
      if (date) {
        return {
          title: `Installation date changed from ${dateOrNotRecorded(date.from)} to ${dateOrNotRecorded(date.to)}`,
          detail: others.length > 0 ? `Also edited: ${others.join(', ')}` : null,
        };
      }
      return { title: 'Details edited', detail: others.join(', ') || null };
    }
    case 'drive-installed':
      return {
        title: `Installed in ${where(slotLink(e, 'to')) ?? 'a slot'}${
          unrecInstall ? ' (installation date not recorded)' : ''
        }`,
        detail: join(roleWord(str(p.role)), note),
      };
    case 'drive-removed':
      return {
        title: `Removed from ${where(slotLink(e, 'from')) ?? 'a slot'}${
          isUnrecordedRemoval(e, driveId) ? ' (removal date not recorded)' : ''
        }`,
        detail: note,
      };
    case 'drive-retired':
    case 'drive-sent-for-rma': {
      // R60, R27: ONE entry; when the drive was installed the bay it left is named.
      const rma = e.type === 'drive-sent-for-rma';
      const from = where(slotLink(e, 'from'));
      const unrec = isUnrecordedRetirement(e, driveId);
      return {
        title: `${rma ? 'Sent for RMA' : 'Retired'}${from ? ` from ${from}` : ''}${
          unrec ? (rma ? ' (date not recorded)' : ' (retirement date not recorded)') : ''
        }`,
        detail: rma ? join(str(p.date), note) : join(str(p.reason), str(p.date), note),
      };
    }
    case 'drive-reinstated':
      return { title: 'Reinstated as a spare', detail: note };
    case 'drive-moved': {
      const from = slotLink(e, 'from');
      const to = slotLink(e, 'to');
      return {
        title: `Moved from ${moveWhere(from, to, 'from')} to ${moveWhere(from, to, 'to')}${
          unrecInstall ? ' (date not recorded)' : ''
        }`,
        detail: null,
      };
    }
    case 'drives-swapped': {
      // R73: this drive's own move, and the other drive it traded places with.
      const mine = (Array.isArray(p.moves) ? p.moves : [])
        .map(rec)
        .find((m) => m.driveId === driveId);
      const from = e.links.slots.find((s) => s.role === 'from' && s.slotId === mine?.fromSlotId);
      const to = e.links.slots.find((s) => s.role === 'to' && s.slotId === mine?.toSlotId);
      const other = e.links.drives.find((d) => d.driveId !== driveId);
      return {
        title: `Swapped with ${driveText(other)} — moved from ${moveWhere(from, to, 'from')} to ${moveWhere(
          from,
          to,
          'to',
        )}${unrecInstall ? ' (date not recorded)' : ''}`,
        detail: null,
      };
    }
    case 'drive-replaced': {
      const at = slotLink(e, 'at');
      const out = driveRef(e, 'outgoing');
      const inc = driveRef(e, 'incoming');
      if (roleOf(e, driveId) === 'outgoing') {
        const o = outgoingOf(e);
        const unrec =
          o.hasDate && o.date === null
            ? o.outcome === 'spares'
              ? ' (removal date not recorded)'
              : o.outcome === 'moved'
                ? ' (date not recorded)'
                : ' (retirement date not recorded)'
            : '';
        return {
          title: `Replaced by ${driveText(inc)} in ${where(at) ?? 'a slot'} — ${outcomeText(e)}${unrec}`,
          detail: str(rec(p.outgoing).note),
        };
      }
      const from = slotLink(e, 'from');
      const suffix = unrecInstall ? ' (installation date not recorded)' : '';
      return {
        title: from
          ? `Moved from ${moveWhere(from, at, 'from')} to ${moveWhere(from, at, 'to')}, replacing ${driveText(out)}${
              unrecInstall ? ' (date not recorded)' : ''
            }`
          : `Installed in ${where(at) ?? 'a slot'}, replacing ${driveText(out)}${suffix}`,
        detail: join(roleWord(str(p.role)), `${out?.serial ?? 'It'} ${outcomeText(e)}`),
      };
    }
    case 'drive-linked':
      return { title: 'Linked to a drive in the NAS', detail: str(p.observationSerial) };
    case 'pool-joined':
      return {
        title: poolName ? `Joined pool ${poolName}` : 'Joined a pool',
        detail: roleWord(str(p.role)),
      };
    case 'pool-left':
      return {
        title: poolName ? `Left pool ${poolName}` : 'Left a pool',
        detail: roleWord(str(p.role)),
      };
    case 'pool-role-changed':
      return { title: 'Pool role changed', detail: join(str(p.from), str(p.to)) };
    case 'health-changed': {
      const h = healthChange(e);
      if (!h) return { title: 'Health changed', detail: null };
      return {
        title: h.from
          ? `Health: ${HEALTH_SHORT[h.from]} → ${HEALTH_SHORT[h.to]}`
          : `Health first reported: ${HEALTH_SHORT[h.to]}`,
        detail: null,
      };
    }
    case 'suggestion-dismissed': {
      // R72: value null means the owner restored the suggestion.
      const field = str(p.field);
      const label = field
        ? (FIELD_LABEL[field as keyof typeof FIELD_LABEL]?.toLowerCase() ?? field)
        : null;
      if (p.value === null || p.value === undefined) {
        return { title: `Restored suggestion for ${label ?? 'a field'}`, detail: null };
      }
      const value = field
        ? formatSuggestionValue(field as keyof typeof FIELD_LABEL, p.value as string | number)
        : String(p.value);
      return { title: `Dismissed suggested ${label ?? 'value'} '${value}'`, detail: null };
    }
    default:
      // Layout and pool record events are not part of a drive's story.
      return { title: e.type.replace(/-/g, ' '), detail: null };
  }
}

/**
 * Events newest first (as the API returns) in, oldest-first story out. `driveId` is the drive whose
 * story this is: it decides whether a replacement reads "Replaced by ..." or "Installed ..., replacing ...".
 */
export function buildStory(eventsNewestFirst: DriveEvent[], driveId: string): StoryItem[] {
  const ordered = orderedByEffective(eventsNewestFirst, driveId);
  return ordered.map((o, i) => {
    const prev = ordered[i - 1];
    const ms = prev ? Date.parse(o.at) - Date.parse(prev.at) : 0;
    const gap = prev ? (ms < 24 * 3600_000 ? 'same day' : `after ${formatDuration(ms)}`) : null;
    const { title, detail } = describe(o.event, driveId);
    return {
      id: o.event.id,
      at: o.at,
      date: o.date,
      recorded: o.recorded,
      unrecorded: isUnrecordedInstall(o.event, driveId),
      removalUnrecorded: isUnrecordedRemoval(o.event, driveId),
      retirementUnrecorded: isUnrecordedRetirement(o.event, driveId),
      kind: o.event.type,
      slot: slotOf(o.event),
      health: healthChange(o.event),
      title,
      detail,
      gap,
    };
  });
}

export interface StorySummary {
  inService: number;
  onShelf: number;
  /**
   * R68: some installed phase has no known installation date. Its time is NOT counted in
   * `inService`: the day it was logged is when it was recorded, not when it went in.
   */
  installUnrecorded: boolean;
  /**
   * R69: a drive was taken out on an unknown date. The installed time before it is NOT counted in
   * `inService` and the shelf time after it is NOT counted in `onShelf`: the day the removal was
   * logged is when it was recorded, not when it happened.
   */
  removalUnrecorded: boolean;
  /**
   * R60: a drive was retired on an unknown date. The shelf time before it is NOT counted in
   * `onShelf`: the day the retirement was logged is when it was recorded, not when it happened.
   */
  retirementUnrecorded: boolean;
}

/** Time installed and time on the shelf, from the event sequence up to `end` (now, or retirement). */
export function summarizeStory(
  eventsNewestFirst: DriveEvent[],
  driveId: string,
  now: number = Date.now(),
): StorySummary {
  const out: StorySummary = {
    inService: 0,
    onShelf: 0,
    installUnrecorded: false,
    removalUnrecorded: false,
    retirementUnrecorded: false,
  };
  type Phase = 'shelf' | 'installed' | 'retired' | null;
  let state: Phase = null as Phase;
  let since = 0;
  let known = true; // is the start of the running phase a real date (R68, R69)?
  const close = (at: number, endKnown: boolean) => {
    if (state === 'shelf' && known && endKnown) out.onShelf += Math.max(0, at - since);
    if (state === 'installed' && known && endKnown) out.inService += Math.max(0, at - since);
    if (state === 'installed' && !known) out.installUnrecorded = true;
    if (state === 'installed' && !endKnown) out.removalUnrecorded = true;
  };
  for (const o of orderedByEffective(eventsNewestFirst, driveId)) {
    const at = Date.parse(o.at);
    const e = o.event;
    const d = dateOf(e, driveId);
    const unknownDate = d.has && d.value === null;
    if (isUnrecordedRetirement(e, driveId)) out.retirementUnrecorded = true;
    const exit = exitOf(e, driveId);
    // The phase this event starts for the drive. A drive that moves between bays stays installed,
    // but the stay restarts on the move date (R73), so a move still closes and reopens the phase.
    const next: Phase =
      e.type === 'drive-created'
        ? state === null
          ? 'shelf'
          : state
        : e.type === 'drive-reinstated'
          ? 'shelf'
          : arrives(e, driveId) && exit !== 'spares' && exit !== 'retired'
            ? 'installed'
            : exit === 'spares'
              ? 'shelf'
              : exit === 'retired'
                ? 'retired'
                : state;
    const restarts = arrives(e, driveId) && next === 'installed' && state === 'installed';
    if (next !== state || restarts) {
      // Leaving a bay, or moving between bays, needs a real date for the time before it to count.
      const leaving = exit !== null || (arrives(e, driveId) && state === 'installed');
      close(at, !(leaving && unknownDate));
      state = next;
      since = at;
      known = !unknownDate;
    }
    // Editing the installation date moves the start of the phase that is running.
    const edit = installedOnChange(e);
    if (state === 'installed' && edit?.to) {
      since = Date.parse(midnight(edit.to));
      known = true;
    } else if (state === 'installed' && edit && edit.to === null) {
      known = false;
    }
  }
  close(now, true);
  return out;
}
