import type { Activity, ActivityEvent, ActivityKind, Health } from '@sparrow/shared';
import { formatBytes, formatDate, formatDuration } from './format';
import { FIELD_LABEL, formatSuggestionValue } from './suggestions';

// R14: the history is read by ACTIVITY. One user action is one entry; its events (atomic facts about at
// most one drive, one bay and one pool each) say what happened to whom. The story of one drive reads an
// activity from that drive's side: its own events decide the wording, and the other drives' serials and
// sizes come from the events they appear in. Events are never paired across activities.

export interface StoryItem {
  id: string;
  /** The effective instant (see `effective`), not necessarily when the activity was recorded. */
  at: string;
  /** YYYY-MM-DD to show for the entry (the activity's day, else the day it was recorded). */
  date: string;
  /** "recorded 2026-10-11" when the entry describes an earlier date than the day it was logged. */
  recorded: string | null;
  /** R68: the drive went into a bay on an unknown date; `date` is then the day it was logged. */
  unrecorded: boolean;
  /** R69: the drive left a bay (to the spares) on an unknown date. */
  removalUnrecorded: boolean;
  /** R60: a retirement or RMA on an unknown date. */
  retirementUnrecorded: boolean;
  kind: ActivityKind;
  /** The bay the entry is about, so the story can link to its history (R74). */
  slot: { id: string; label: string } | null;
  /** R20: set on health entries, so the view can add the icon and colour for `to`. */
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
const dateStr = (v: unknown): string | null => {
  const s = str(v);
  return s !== null && DATE_ONLY.test(s) ? s : null;
};
const midnight = (date: string) => `${date}T00:00:00.000Z`;

/** What one activity did to one drive: its own events, found by type. */
interface Side {
  activity: Activity;
  created?: ActivityEvent;
  linked?: ActivityEvent;
  installed?: ActivityEvent;
  uninstalled?: ActivityEvent;
  retired?: ActivityEvent;
  rma: boolean;
  reinstated?: ActivityEvent;
  health?: ActivityEvent;
  installationUpdated?: ActivityEvent;
  mine: ActivityEvent[];
}

function sideOf(activity: Activity, driveId: string): Side {
  const mine = activity.events.filter((e) => e.driveId === driveId);
  const first = (type: ActivityEvent['type']) => mine.find((e) => e.type === type);
  const retired = first('drive-retired') ?? first('drive-sent-for-rma');
  return {
    activity,
    ...opt('created', first('drive-created')),
    ...opt('linked', first('drive-linked')),
    ...opt('installed', first('drive-installed')),
    ...opt('uninstalled', first('drive-uninstalled')),
    ...opt('retired', retired),
    rma: retired?.type === 'drive-sent-for-rma',
    ...opt('reinstated', first('drive-reinstated')),
    ...opt('health', first('health-changed')),
    ...opt('installationUpdated', first('installation-updated')),
    mine,
  };
}
const opt = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });

/** True when the activity moved this drive into or out of a bay or retired it: it carries a user date (R60, R68, R69). */
const dateBearing = (s: Side) => Boolean(s.installed ?? s.uninstalled ?? s.retired);

/**
 * R68, R69, R60: the log records WHEN a change was recorded (`recordedAt`); an activity can describe an
 * earlier day (`occurredOn`). The story orders by the effective instant: the activity's day (unless it
 * is the very day it was logged, then the recording time keeps same-day order exact); for a health poll
 * the time the provider reported. A missing date ("not recorded") keeps the logging time. Ties keep the
 * log order (seq).
 */
function effective(s: Side): { at: string; date: string; recorded: string | null } {
  const a = s.activity;
  const logged = formatDate(a.recordedAt);
  if (s.health) {
    const reported = str(s.health.payload.reportedAt);
    if (reported !== null && !Number.isNaN(Date.parse(reported))) {
      return { at: reported, date: formatDate(reported), recorded: null };
    }
  }
  const on = dateStr(a.occurredOn);
  if (on === null) return { at: a.recordedAt, date: logged, recorded: null };
  const at = on === a.recordedAt.slice(0, 10) ? a.recordedAt : midnight(on);
  return { at, date: on, recorded: on !== logged ? logged : null };
}

function ordered(activitiesNewestFirst: Activity[], driveId: string) {
  return activitiesNewestFirst
    .map((activity) => {
      const side = sideOf(activity, driveId);
      return { side, ...effective(side) };
    })
    .sort(
      (x, y) => Date.parse(x.at) - Date.parse(y.at) || x.side.activity.seq - y.side.activity.seq,
    );
}

/** "Front bays, Bay 3" from the bay as the event copied it (stable after renames, R39). */
function where(e: ActivityEvent | undefined): string | null {
  if (!e) return null;
  const label = str(e.slotLabel);
  const grid = str(e.gridName);
  return label && grid ? `${grid}, ${label}` : (label ?? grid);
}

/** "Bay 3" when both bays are in the same grid, else "Front bays, Bay 3". */
function moveWhere(
  from: ActivityEvent | undefined,
  to: ActivityEvent | undefined,
  end: 'from' | 'to',
): string {
  const e = end === 'from' ? from : to;
  const sameGrid = from !== undefined && to !== undefined && from.gridName === to.gridName;
  return (sameGrid ? str(e?.slotLabel) : where(e)) ?? where(e) ?? 'a slot';
}

/** "ZL2SPR01 (8 TB)" for another drive named in an event. */
function driveText(e: ActivityEvent | undefined): string {
  const d = e?.drive;
  if (!d) return 'another drive';
  const size = formatBytes(d.capacityBytes);
  return size ? `${d.serial} (${size})` : d.serial;
}

const roleWord = (role: unknown): string | null => (role === 'hot-spare' ? 'hot spare' : str(role));

/** "tank (data)" for the pool of an installed / uninstalled event. */
function poolText(e: ActivityEvent | undefined): string | null {
  const name = str(e?.poolName);
  if (!name) return null;
  const role = roleWord(e?.payload.poolRole);
  return role ? `${name} (${role})` : name;
}

/** R22: the serial a link replaced, from the drive-linked event's `filled.serial`. */
export function linkedSerialChange(
  e: ActivityEvent | undefined,
): { from: string; to: string } | null {
  const filled = e?.payload.filled;
  const change =
    typeof filled === 'object' && filled !== null
      ? (filled as Record<string, { from?: unknown; to?: unknown }>).serial
      : undefined;
  const from = str(change?.from);
  const to = str(change?.to);
  return from && to ? { from, to } : null;
}

const join = (...parts: (string | null)[]): string | null =>
  parts.filter(Boolean).join(' · ') || null;

export const HEALTH_SHORT: Record<Health, string> = {
  ok: 'OK',
  warning: 'Warning',
  failed: 'Failed',
  unknown: 'Unknown',
};
const HEALTH_VALUES = new Set<string>(Object.keys(HEALTH_SHORT));
export const healthOf = (v: unknown): Health | null =>
  typeof v === 'string' && HEALTH_VALUES.has(v) ? (v as Health) : null;

/** R20: the from/to of a health-changed event, or null when it is not one (or is malformed). */
function healthChange(s: Side): { from: Health | null; to: Health } | null {
  if (!s.health) return null;
  const to = healthOf(s.health.payload.to);
  return to === null ? null : { from: healthOf(s.health.payload.from), to };
}

/** The installation-date change an installation-updated event carries, if any (R68). */
function installedOnChange(s: Side): { from: string | null; to: string | null } | null {
  const c = rec(rec(s.installationUpdated?.payload.changes).installedOn);
  if (!s.installationUpdated || !('to' in c)) return null;
  return { from: dateStr(c.from), to: dateStr(c.to) };
}

const dateOrNotRecorded = (v: string | null) => v ?? 'not recorded';

/** The fields a drive-updated event changed, by our own labels (R53: never the provider's names). */
function changedFields(s: Side): string[] {
  const out: string[] = [];
  for (const e of s.mine) {
    if (e.type === 'drive-updated') out.push(...Object.keys(rec(e.payload.changes)));
  }
  return out;
}
const fieldLabel = (k: string) => FIELD_LABEL[k as keyof typeof FIELD_LABEL]?.toLowerCase() ?? k;

/** What became of a drive that left a bay in this activity, in words. */
function outcomeWord(u: ActivityEvent, s: Side['activity']): string {
  const mine = s.events.filter((e) => e.driveId === u.driveId);
  const retired = mine.find((e) => e.type === 'drive-retired');
  const rma = mine.find((e) => e.type === 'drive-sent-for-rma');
  if (rma) return 'sent for RMA';
  if (retired) {
    const reason = str(retired.payload.reason);
    return reason ? `retired (${reason})` : 'retired';
  }
  const arrived = mine.find((e) => e.type === 'drive-installed');
  if (arrived) return `moved to ${where(arrived) ?? 'another bay'}`;
  return 'back to spares';
}

/** "it was retired (failed)", "it went back to spares": what became of a displaced drive. */
const displacedPhrase = (outcome: string) =>
  outcome.startsWith('back to') ? `it went ${outcome}` : `it was ${outcome}`;

/** The drive that left `slotId` in this activity other than `driveId` (it made room), if any. */
const displacedAt = (a: Activity, slotId: string | null, driveId: string) =>
  slotId === null
    ? undefined
    : a.events.find(
        (e) => e.type === 'drive-uninstalled' && e.slotId === slotId && e.driveId !== driveId,
      );
/** The drive installed into `slotId` in this activity other than `driveId` (it took the bay), if any. */
const takerAt = (a: Activity, slotId: string | null, driveId: string) =>
  slotId === null
    ? undefined
    : a.events.find(
        (e) => e.type === 'drive-installed' && e.slotId === slotId && e.driveId !== driveId,
      );

function describeSlotChange(s: Side): { title: string; detail: string | null } {
  const a = s.activity;
  const note = str(a.note);
  const { installed: i, uninstalled: u, retired: r } = s;
  const driveId = (i ?? u ?? r)?.driveId ?? '';
  const retiredNote = str(r?.payload.note);
  const unrec = (what: string) => (a.occurredOn === null ? ` (${what} not recorded)` : '');

  if (i && u) {
    if (a.kind === 'swapped') {
      const other = a.events.find((e) => e.type === 'drive-uninstalled' && e.driveId !== driveId);
      return {
        title: `Swapped with ${driveText(other)} — ${moveWhere(u, i, 'from')} → ${moveWhere(u, i, 'to')}${unrec('date')}`,
        detail: note,
      };
    }
    const displaced = displacedAt(a, i.slotId, driveId);
    const taker = takerAt(a, u.slotId, driveId);
    return {
      title:
        join(
          `Moved ${moveWhere(u, i, 'from')} → ${moveWhere(u, i, 'to')}${unrec('date')}`,
          displaced ? `replaced ${driveText(displaced)}` : null,
          displaced ? displacedPhrase(outcomeWord(displaced, a)) : null,
          poolText(i),
        ) ?? 'Moved',
      detail: join(taker ? `${driveText(taker)} took ${where(u) ?? 'the bay'}` : null, note),
    };
  }
  if (i) {
    const displaced = displacedAt(a, i.slotId, driveId);
    const main = displaced
      ? `Replaced ${driveText(displaced)} in ${where(i) ?? 'a slot'}`
      : `Installed in ${where(i) ?? 'a slot'}`;
    return {
      title: join(
        main + unrec('installation date'),
        displaced ? displacedPhrase(outcomeWord(displaced, a)) : null,
        poolText(i),
      )!,
      detail: note,
    };
  }
  if (u) {
    const taker = takerAt(a, u.slotId, driveId);
    const outcome = outcomeWord(u, a);
    const leftPool = str(u.poolName) ? `left ${u.poolName}` : null;
    const date = r ? unrec('retirement date') : unrec('removal date');
    if (taker) {
      return {
        title: join(
          `Replaced by ${driveText(taker)} in ${where(u) ?? 'a slot'}${date}`,
          outcome,
          leftPool,
        )!,
        detail: join(retiredNote, note),
      };
    }
    const lead = r
      ? `${s.rma ? 'Sent for RMA' : 'Retired'} from ${where(u) ?? 'a slot'}${date}`
      : `Removed from ${where(u) ?? 'a slot'}${date}`;
    return {
      title: join(lead, r ? null : outcome, leftPool)!,
      detail: join(r && !s.rma ? str(r.payload.reason) : null, retiredNote, note),
    };
  }
  // A retirement of a drive that was on the shelf.
  return {
    title: `${s.rma ? 'Sent for RMA' : 'Retired'}${unrec('retirement date')}`,
    detail: join(s.rma ? null : str(r?.payload.reason), retiredNote, note),
  };
}

function describe(s: Side): { title: string; detail: string | null } {
  const a = s.activity;
  const note = str(a.note);
  switch (a.kind) {
    case 'drive-added':
      return {
        title: 'Added to Sparrow',
        detail: join(str(s.created?.payload.condition), str(s.created?.payload.vendor)),
      };
    case 'discovered-created': {
      const placed = s.installed ? describeSlotChange(s) : null;
      return {
        title: join('Found in the NAS and added', placed ? lowerFirst(placed.title) : null)!,
        detail: placed?.detail ?? null,
      };
    }
    case 'discovered-linked': {
      const serial = linkedSerialChange(s.linked);
      const placed = s.installed ? describeSlotChange(s) : null;
      return {
        title: join('Linked to a drive in the NAS', placed ? lowerFirst(placed.title) : null)!,
        detail: join(
          str(s.linked?.payload.observationSerial),
          serial && `serial ${serial.from} → ${serial.to}`,
          placed?.detail ?? null,
        ),
      };
    }
    case 'retired-imported': {
      const reason = str(s.retired?.payload.reason);
      return {
        title: `Imported as a retired drive${reason ? ` (${reason})` : ''}${a.occurredOn === null ? ' (retirement date not recorded)' : ''}`,
        detail: str(s.retired?.payload.note),
      };
    }
    case 'suggestions-applied': {
      const names = changedFields(s).map(fieldLabel);
      return {
        title: `Details updated from the provider${names.length > 0 ? `: ${names.join(', ')}` : ''}`,
        detail: null,
      };
    }
    case 'drive-edited': {
      const date = installedOnChange(s);
      const others = changedFields(s);
      if (date) {
        return {
          title: `Installation date changed from ${dateOrNotRecorded(date.from)} to ${dateOrNotRecorded(date.to)}`,
          detail: others.length > 0 ? `Also edited: ${others.join(', ')}` : null,
        };
      }
      return { title: 'Details edited', detail: others.join(', ') || null };
    }
    case 'suggestions-dismissed':
    case 'suggestions-restored': {
      const parts = s.mine
        .filter((e) => e.type === 'suggestion-dismissed')
        .map((e) => {
          const field = str(e.payload.field);
          const label = field ? fieldLabel(field) : 'value';
          if (a.kind === 'suggestions-restored') return label;
          const value = field
            ? formatSuggestionValue(
                field as keyof typeof FIELD_LABEL,
                e.payload.value as string | number,
              )
            : String(e.payload.value);
          return `${label} '${value}'`;
        });
      if (a.kind === 'suggestions-restored') {
        return {
          title: `Restored suggestion${parts.length === 1 ? '' : 's'} for ${parts.join(', ') || 'a field'}`,
          detail: null,
        };
      }
      return {
        title:
          parts.length === 1
            ? `Dismissed suggested ${parts[0]}`
            : `Dismissed suggestions: ${parts.join(', ')}`,
        detail: null,
      };
    }
    case 'pool-joined':
    case 'pool-left':
    case 'pool-role-changed':
    case 'pool-changed': {
      const joined = s.mine.find((e) => e.type === 'pool-joined');
      const left = s.mine.find((e) => e.type === 'pool-left');
      const changed = s.mine.find((e) => e.type === 'pool-role-changed');
      if (joined && left) {
        return {
          title: `Changed pool from ${left.poolName ?? 'a pool'} to ${joined.poolName ?? 'a pool'}`,
          detail: roleWord(joined.payload.poolRole),
        };
      }
      if (joined) {
        return {
          title: joined.poolName ? `Joined pool ${joined.poolName}` : 'Joined a pool',
          detail: roleWord(joined.payload.poolRole),
        };
      }
      if (left) {
        return {
          title: left.poolName ? `Left pool ${left.poolName}` : 'Left a pool',
          detail: roleWord(left.payload.poolRole),
        };
      }
      return {
        title: 'Pool role changed',
        detail: changed
          ? `${roleWord(changed.payload.from) ?? '?'} → ${roleWord(changed.payload.to) ?? '?'}`
          : null,
      };
    }
    case 'reinstated':
      return { title: 'Reinstated as a spare', detail: note };
    case 'health-polled': {
      const h = healthChange(s);
      if (!h) return { title: 'Health changed', detail: null };
      return {
        title: h.from
          ? `Health: ${HEALTH_SHORT[h.from]} → ${HEALTH_SHORT[h.to]}`
          : `Health first reported: ${HEALTH_SHORT[h.to]}`,
        detail: null,
      };
    }
    case 'assigned':
    case 'replaced':
    case 'removed':
    case 'retired':
    case 'sent-for-rma':
    case 'moved':
    case 'swapped':
      return describeSlotChange(s);
    default:
      // Layout and pool record activities are not part of a drive's story.
      return { title: a.kind.replace(/-/g, ' '), detail: null };
  }
}

const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

/** The bay a story entry is about, so it can link to the bay's history (R74). */
function slotOf(s: Side): StoryItem['slot'] {
  const e = s.installed ?? s.uninstalled;
  return e?.slotId ? { id: e.slotId, label: str(e.slotLabel) ?? 'this slot' } : null;
}

/**
 * Activities newest first (as the API returns them) in, oldest-first story out. `driveId` is the drive
 * whose story this is: it decides whether a replacement reads "Replaced by ..." or "Replaced ...".
 */
export function buildStory(activitiesNewestFirst: Activity[], driveId: string): StoryItem[] {
  const items = ordered(activitiesNewestFirst, driveId);
  return items.map((o, i) => {
    const prev = items[i - 1];
    const ms = prev ? Date.parse(o.at) - Date.parse(prev.at) : 0;
    const gap = prev ? (ms < 24 * 3600_000 ? 'same day' : `after ${formatDuration(ms)}`) : null;
    const { title, detail } = describe(o.side);
    const a = o.side.activity;
    const unknown = dateBearing(o.side) && a.occurredOn === null;
    return {
      id: a.id,
      at: o.at,
      date: o.date,
      recorded: o.recorded,
      unrecorded: unknown && Boolean(o.side.installed),
      removalUnrecorded:
        unknown && Boolean(o.side.uninstalled) && !o.side.retired && !o.side.installed,
      retirementUnrecorded: unknown && Boolean(o.side.retired),
      kind: a.kind,
      slot: slotOf(o.side),
      health: healthChange(o.side),
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
   * `inService` and the shelf time after it is NOT counted in `onShelf`.
   */
  removalUnrecorded: boolean;
  /**
   * R60: a drive was retired on an unknown date. The shelf time before it is NOT counted in
   * `onShelf`: the day the retirement was logged is when it was recorded, not when it happened.
   */
  retirementUnrecorded: boolean;
}

/** Time installed and time on the shelf, from the activity sequence up to `end` (now, or retirement). */
export function summarizeStory(
  activitiesNewestFirst: Activity[],
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
  for (const o of ordered(activitiesNewestFirst, driveId)) {
    const at = Date.parse(o.at);
    const s = o.side;
    const unknownDate = dateBearing(s) && s.activity.occurredOn === null;
    if (s.retired && unknownDate) out.retirementUnrecorded = true;
    // The phase this activity starts for the drive. A drive that moves between bays stays installed,
    // but the stay restarts on the move date (R73), so a move still closes and reopens the phase.
    const next: Phase = s.retired
      ? 'retired'
      : s.installed
        ? 'installed'
        : s.uninstalled || s.reinstated
          ? 'shelf'
          : s.created
            ? state === null
              ? 'shelf'
              : state
            : state;
    const restarts = Boolean(s.installed) && next === 'installed' && state === 'installed';
    if (next !== state || restarts) {
      // Leaving a bay, or moving between bays, needs a real date for the time before it to count.
      const leaving =
        Boolean(s.uninstalled) ||
        Boolean(s.retired) ||
        (Boolean(s.installed) && state === 'installed');
      close(at, !(leaving && unknownDate));
      state = next;
      since = at;
      known = !unknownDate;
    }
    // Editing the installation date moves the start of the phase that is running.
    const edit = installedOnChange(s);
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
