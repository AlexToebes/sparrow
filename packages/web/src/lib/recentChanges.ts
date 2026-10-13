import type { Activity, ActivityEvent, ActivityKind, Health } from '@sparrow/shared';
import { formatBytes, formatDate } from './format';
import { formatGridSize } from './grid';
import { HEALTH_SHORT, healthOf } from './lifeStory';
import { FIELD_LABEL } from './suggestions';

// R75: the enclosure-wide feed of recent changes. One plain-language sentence per ACTIVITY, written from a
// neutral point of view (the life story reads an activity from one drive's side). Serials link to the drive
// and bays to the bay's history; both come from the events (the serial from the drive record, the bay's
// label and grid as the event copied them, R39).

/** A piece of a sentence: plain text, or text that links somewhere. */
export type Part = string | { text: string; to: string };

/** The family an entry's icon and colour belong to. */
export type FeedIcon = 'drive' | 'bay' | 'pool' | 'layout' | 'health' | 'suggestion';

export interface FeedItem {
  id: string;
  seq: number;
  kind: ActivityKind;
  /** YYYY-MM-DD: the activity's own day (`occurredOn`), else the day it was recorded (local time, D3). */
  date: string;
  /** The day it was recorded, when the activity describes a different (earlier) day. */
  recorded: string | null;
  icon: FeedIcon;
  /** Set on health entries, so the view can add the status icon and colour. */
  health: Health | null;
  parts: Part[];
  /** The sentence as plain text (tests, aria labels). */
  text: string;
}

/** The icon family of every activity kind. A full record, so a new kind will not compile without one. */
export const KIND_ICON: Record<ActivityKind, FeedIcon> = {
  'drive-added': 'drive',
  'discovered-created': 'drive',
  'discovered-linked': 'drive',
  'retired-imported': 'drive',
  'drive-edited': 'drive',
  'suggestions-applied': 'suggestion',
  'suggestions-dismissed': 'suggestion',
  'suggestions-restored': 'suggestion',
  assigned: 'bay',
  replaced: 'bay',
  removed: 'bay',
  retired: 'bay',
  'sent-for-rma': 'bay',
  reinstated: 'drive',
  moved: 'bay',
  swapped: 'bay',
  'pool-joined': 'pool',
  'pool-left': 'pool',
  'pool-role-changed': 'pool',
  'pool-changed': 'pool',
  'health-polled': 'health',
  'layout-updated': 'layout',
  'pool-edited': 'pool',
};

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const roleWord = (role: unknown): string | null => (role === 'hot-spare' ? 'hot spare' : str(role));
const fieldLabel = (k: string) => FIELD_LABEL[k as keyof typeof FIELD_LABEL]?.toLowerCase() ?? k;

type Leaf = Part | null | undefined | false;
type Chunks = ReadonlyArray<Leaf | Chunks>;

/** Sentence builder: plain strings, links and (nested) lists of them in order, merged into the fewest parts. */
function sentence(...chunks: (Leaf | Chunks)[]): Part[] {
  const out: Part[] = [];
  const add = (c: Leaf | Chunks): void => {
    if (Array.isArray(c)) {
      for (const inner of c as Chunks) add(inner);
      return;
    }
    const leaf = c as Leaf;
    if (leaf === null || leaf === undefined || leaf === false || leaf === '') return;
    const last = out[out.length - 1];
    if (typeof leaf === 'string' && typeof last === 'string') out[out.length - 1] = last + leaf;
    else out.push(leaf);
  };
  for (const c of chunks) add(c);
  return out;
}
const toText = (parts: Part[]) => parts.map((p) => (typeof p === 'string' ? p : p.text)).join('');
/** Whole sentences joined with " · ". */
const joinSentences = (items: Part[][]): Part[] =>
  sentence(...items.filter((i) => i.length > 0).flatMap((i, n) => (n === 0 ? [i] : [' · ', i])));

/** "ZL2SPR01" linking to the drive; with the size when asked ("ZL2SPR01 (8 TB)"). */
function drive(e: ActivityEvent | undefined, withSize = false): Part[] {
  const d = e?.drive;
  if (!e || !d || !e.driveId) return ['a drive'];
  const size = withSize ? formatBytes(d.capacityBytes) : '';
  return sentence(
    { text: d.serial, to: `/drives?drive=${encodeURIComponent(e.driveId)}` },
    size ? ` (${size})` : '',
  );
}

/** "Front bays, 3" linking to the bay's history, from the label and grid the event copied. */
function bay(e: ActivityEvent | undefined): Part[] {
  const label = str(e?.slotLabel);
  const grid = str(e?.gridName);
  const text = label && grid ? `${grid}, ${label}` : (label ?? grid);
  if (!e || !text) return ['a bay'];
  return e.slotId ? [{ text, to: `/?slot=${encodeURIComponent(e.slotId)}&view=slot` }] : [text];
}

function poolPart(e: ActivityEvent | undefined): string | null {
  const name = str(e?.poolName);
  if (!name) return null;
  const role = roleWord(e?.payload.poolRole);
  return role ? `${name} (${role})` : name;
}

const ofType = (a: Activity, type: ActivityEvent['type']) =>
  a.events.filter((e) => e.type === type);

/** What became of a drive that left its bay in this activity. */
function outcome(a: Activity, driveId: string | null): Part[] {
  const mine = a.events.filter((e) => e.driveId === driveId);
  if (mine.some((e) => e.type === 'drive-sent-for-rma')) return ['sent for RMA'];
  const retired = mine.find((e) => e.type === 'drive-retired');
  if (retired) {
    const reason = str(retired.payload.reason);
    return [reason ? `retired (${reason})` : 'retired'];
  }
  const arrived = mine.find((e) => e.type === 'drive-installed');
  if (arrived) return sentence('moved to ', bay(arrived));
  return ['back to spares'];
}

/** The bay changes of an activity: installs, removals, retirements, replacements, moves and swaps. */
function describeBays(a: Activity): Part[] {
  const installs = ofType(a, 'drive-installed');
  const uninstalls = ofType(a, 'drive-uninstalled');

  if (a.kind === 'swapped' && uninstalls.length === 2) {
    const [x, y] = uninstalls as [ActivityEvent, ActivityEvent];
    return sentence('Swapped ', drive(x), ' (', bay(x), ') and ', drive(y), ' (', bay(y), ')');
  }

  const used = new Set<ActivityEvent>();
  const out: Part[][] = [];
  const movedDrives = new Set(
    installs.filter((i) => uninstalls.some((u) => u.driveId === i.driveId)).map((i) => i.driveId),
  );

  for (const i of installs) {
    const own = uninstalls.find((u) => u.driveId === i.driveId);
    const displaced = uninstalls.find((u) => u.slotId === i.slotId && u.driveId !== i.driveId);
    if (own) used.add(own);
    if (displaced) used.add(displaced);
    const pool = poolPart(i);
    const tail: Part[][] = [];
    let main: Part[];
    if (displaced && movedDrives.has(displaced.driveId)) {
      // The displaced drive moved on and has its own sentence: this one only took the bay.
      main = sentence(drive(i, true), ' took ', bay(i));
    } else if (displaced) {
      main = sentence(
        drive(i, true),
        own ? [' moved ', bay(own), ' → ', bay(i), ', replacing '] : ' replaced ',
        drive(displaced),
        own ? '' : [' in ', bay(i)],
      );
      tail.push(sentence(drive(displaced), ' ', outcome(a, displaced.driveId)));
    } else if (own) {
      main = sentence(drive(i, true), ' moved ', bay(own), ' → ', bay(i));
    } else {
      main = sentence(drive(i, true), ' installed in ', bay(i));
    }
    out.push(joinSentences([main, ...tail, pool ? [pool] : []]));
  }

  for (const u of uninstalls) {
    if (used.has(u)) continue;
    const rma = a.events.some((e) => e.driveId === u.driveId && e.type === 'drive-sent-for-rma');
    const retired = a.events.find((e) => e.driveId === u.driveId && e.type === 'drive-retired');
    if (rma) {
      out.push(sentence(drive(u), ' sent for RMA from ', bay(u)));
    } else if (retired) {
      const reason = str(retired.payload.reason);
      out.push(sentence(drive(u), ' retired from ', bay(u), reason ? ` (${reason})` : ''));
    } else {
      out.push(sentence(drive(u), ' removed from ', bay(u), ' · back to spares'));
    }
  }

  // Retired or sent for RMA from the shelf: no bay involved.
  for (const r of a.events) {
    if (r.type !== 'drive-retired' && r.type !== 'drive-sent-for-rma') continue;
    if (uninstalls.some((u) => u.driveId === r.driveId)) continue;
    const reason = str(r.payload.reason);
    out.push(
      r.type === 'drive-sent-for-rma'
        ? sentence(drive(r), ' sent for RMA')
        : sentence(drive(r), ' retired', reason ? ` (${reason})` : ''),
    );
  }
  return joinSentences(out);
}

function describeLayoutEvent(e: ActivityEvent): Part[] {
  const p = e.payload;
  const q = (name: string | null) => `'${name ?? '?'}'`;
  switch (e.type) {
    case 'enclosure-created':
      return [`Enclosure ${q(str(p.name))} created`];
    case 'enclosure-renamed':
      return [`Enclosure ${q(str(p.from))} renamed to ${q(str(p.to))}`];
    case 'enclosure-deleted':
      return [`Enclosure ${q(str(p.name))} deleted`];
    case 'grid-created': {
      const rows = num(p.rows);
      const columns = num(p.columns);
      const size =
        rows !== null && columns !== null
          ? ` (${formatGridSize(rows, columns, p.orientation === 'portrait' ? 'portrait' : 'landscape')})`
          : '';
      return [`Grid ${q(str(p.name))} created${size}`];
    }
    case 'grid-deleted':
      return [`Grid ${q(str(p.name))} deleted`];
    case 'grid-updated': {
      const changes = rec(p.changes);
      const after = rec(p.after);
      const change = (k: string) => rec(changes[k]);
      const now = str(after.name) ?? str(change('name').to) ?? str(e.gridName);
      const out: Part[][] = [];
      if ('name' in changes) {
        out.push([`Grid ${q(str(change('name').from))} renamed to ${q(str(change('name').to))}`]);
      }
      if ('rows' in changes || 'columns' in changes) {
        // `changes` lists only what differs; `after` has the rest (an unchanged dimension is the same
        // on both sides). A flip in the same edit changes how each side is drawn.
        const dim = (k: 'rows' | 'columns', side: 'from' | 'to') =>
          num(change(k)[side]) ?? num(after[k]);
        const orient = (side: 'from' | 'to') =>
          (change('orientation')[side] ?? after.orientation) === 'portrait'
            ? 'portrait'
            : 'landscape';
        const size = (side: 'from' | 'to') => {
          const rows = dim('rows', side);
          const columns = dim('columns', side);
          return rows !== null && columns !== null
            ? formatGridSize(rows, columns, orient(side))
            : '?';
        };
        out.push([`Grid ${q(now)} resized ${size('from')} → ${size('to')}`]);
      }
      if ('orientation' in changes) {
        out.push([`Grid ${q(now)} flipped to ${str(change('orientation').to) ?? 'the other way'}`]);
      }
      return joinSentences(out.length > 0 ? out : [[`Grid ${q(now)} updated`]]);
    }
    case 'slot-relabeled':
      return sentence(`Bay ${q(str(p.from))} renamed to `, bay(e));
    default:
      return [];
  }
}

function describeLayout(a: Activity): Part[] {
  const enclosure = a.events.find((e) => e.type === 'enclosure-created');
  const grids = ofType(a, 'grid-created');
  if (enclosure && grids.length > 0 && a.events.every((e) => e.type.endsWith('-created'))) {
    const quoted = (list: typeof grids) => list.map((g) => `'${str(g.payload.name) ?? '?'}'`);
    // The setup wizard (R77) also creates pools in the same activity.
    const pools = ofType(a, 'pool-created');
    return [
      `Enclosure '${str(enclosure.payload.name) ?? '?'}' created with ${quoted(grids).join(', ')}` +
        (pools.length > 0
          ? ` and ${pools.length === 1 ? 'pool' : 'pools'} ${quoted(pools).join(', ')}`
          : ''),
    ];
  }
  return joinSentences(a.events.map(describeLayoutEvent));
}

const POOL_FIELDS: Record<string, string> = {
  layoutLabel: 'layout label',
  expectedMembers: 'expected drives',
};

function describePoolRecord(a: Activity): Part[] {
  return joinSentences(
    a.events.map((e): Part[] => {
      const name = str(e.poolName) ?? str(e.payload.name) ?? 'a pool';
      if (e.type === 'pool-created') return [`Pool ${name} created`];
      if (e.type === 'pool-deleted') return [`Pool ${name} deleted`];
      if (e.type === 'pool-updated') {
        const changes = rec(e.payload.changes);
        const renamed = rec(changes.name);
        if ('name' in changes) {
          return [`Pool ${str(renamed.from) ?? '?'} renamed to ${str(renamed.to) ?? '?'}`];
        }
        const fields = Object.keys(changes).map((k) => POOL_FIELDS[k] ?? k);
        return [`Pool ${name} updated${fields.length > 0 ? ` (${fields.join(', ')})` : ''}`];
      }
      return [];
    }),
  );
}

const HEALTH_RANK: Record<Health, number> = { failed: 3, warning: 2, unknown: 1, ok: 0 };

function describeHealth(a: Activity): { parts: Part[]; health: Health | null } {
  const changes = ofType(a, 'health-changed').flatMap((e) => {
    const to = healthOf(e.payload.to);
    return to === null ? [] : [{ e, from: healthOf(e.payload.from), to }];
  });
  if (changes.length === 0) return { parts: ['Health changed'], health: null };
  const items = changes.map((c) =>
    sentence(
      drive(c.e),
      c.from
        ? ` ${HEALTH_SHORT[c.from]} → ${HEALTH_SHORT[c.to]}`
        : ` first reported ${HEALTH_SHORT[c.to]}`,
    ),
  );
  const parts: Part[] = ['Health: '];
  items.forEach((item, n) => parts.push(...(n === 0 ? [] : [', ']), ...item));
  // The icon follows the most serious change, so the row never looks calmer than it is.
  const worst = changes.reduce(
    (w, c) => (HEALTH_RANK[c.to] > HEALTH_RANK[w] ? c.to : w),
    changes[0]!.to,
  );
  return { parts: sentence(...parts), health: worst };
}

const changedFields = (a: Activity) =>
  ofType(a, 'drive-updated').flatMap((e) => Object.keys(rec(e.payload.changes)));

/** The drive-record activities: adding, discovering, editing, suggestions, pools, reinstating. */
function describeDrive(a: Activity): Part[] {
  const first = a.events.find((e) => e.driveId !== null);
  const placed = ofType(a, 'drive-installed')[0];
  const placedText = placed ? sentence('installed in ', bay(placed)) : [];
  switch (a.kind) {
    case 'drive-added':
      return sentence(drive(first, true), ' added to Sparrow');
    case 'discovered-created':
      return joinSentences([
        sentence(drive(first, true), ' found in the NAS and added'),
        placedText,
      ]);
    case 'discovered-linked':
      return joinSentences([sentence(drive(first), ' linked to a drive in the NAS'), placedText]);
    case 'retired-imported': {
      const reason = str(ofType(a, 'drive-retired')[0]?.payload.reason);
      return sentence(drive(first, true), ' imported as retired', reason ? ` (${reason})` : '');
    }
    case 'drive-edited': {
      const date = ofType(a, 'installation-updated').find(
        (e) => 'installedOn' in rec(e.payload.changes),
      );
      if (date) {
        const c = rec(rec(date.payload.changes).installedOn);
        return sentence(
          drive(first),
          ` installation date changed ${str(c.from) ?? 'not recorded'} → ${str(c.to) ?? 'not recorded'}`,
        );
      }
      const fields = changedFields(a);
      return sentence(
        drive(first),
        ' details edited',
        fields.length > 0 ? ` (${fields.map(fieldLabel).join(', ')})` : '',
      );
    }
    case 'suggestions-applied': {
      const fields = changedFields(a);
      return sentence(
        drive(first),
        ' updated from the provider',
        fields.length > 0 ? ` (${fields.map(fieldLabel).join(', ')})` : '',
      );
    }
    case 'suggestions-dismissed':
    case 'suggestions-restored': {
      const fields = ofType(a, 'suggestion-dismissed').map((e) =>
        fieldLabel(str(e.payload.field) ?? 'value'),
      );
      return sentence(
        a.kind === 'suggestions-dismissed' ? 'Dismissed suggested ' : 'Restored suggested ',
        fields.join(', ') || 'values',
        ' for ',
        drive(first),
      );
    }
    case 'reinstated':
      return sentence(drive(first), ' reinstated as a spare');
    case 'pool-joined':
    case 'pool-left':
    case 'pool-role-changed':
    case 'pool-changed': {
      const joined = ofType(a, 'pool-joined')[0];
      const left = ofType(a, 'pool-left')[0];
      const changed = ofType(a, 'pool-role-changed')[0];
      if (joined && left) {
        return sentence(
          drive(first),
          ` changed pool from ${left.poolName ?? 'a pool'} to ${poolPart(joined) ?? 'a pool'}`,
        );
      }
      if (joined) return sentence(drive(first), ` joined pool ${poolPart(joined) ?? ''}`.trimEnd());
      if (left) return sentence(drive(first), ` left pool ${left.poolName ?? ''}`.trimEnd());
      return sentence(
        drive(first),
        ' changed role',
        changed
          ? ` ${roleWord(changed.payload.from) ?? '?'} → ${roleWord(changed.payload.to) ?? '?'}`
          : '',
        str(changed?.poolName) ? ` in ${changed!.poolName}` : '',
      );
    }
    default:
      return [];
  }
}

/**
 * The sentence for one activity, from its kind and events. EVERY kind in ACTIVITY_KINDS has wording
 * (the test walks the list); an unknown kind from a newer server falls back to its own name.
 */
export function describeActivity(a: Activity): { parts: Part[]; health: Health | null } {
  switch (a.kind) {
    case 'assigned':
    case 'replaced':
    case 'removed':
    case 'retired':
    case 'sent-for-rma':
    case 'moved':
    case 'swapped':
      return { parts: describeBays(a), health: null };
    case 'health-polled':
      return describeHealth(a);
    case 'layout-updated':
      return { parts: describeLayout(a), health: null };
    case 'pool-edited':
      return { parts: describePoolRecord(a), health: null };
    default:
      return { parts: describeDrive(a), health: null };
  }
}

export function feedItem(a: Activity): FeedItem {
  const { parts, health } = describeActivity(a);
  const logged = formatDate(a.recordedAt);
  const finalParts = parts.length > 0 ? parts : [a.kind.replace(/-/g, ' ')];
  return {
    id: a.id,
    seq: a.seq,
    kind: a.kind,
    date: a.occurredOn ?? logged,
    recorded: a.occurredOn !== null && a.occurredOn !== logged ? logged : null,
    icon: KIND_ICON[a.kind] ?? 'drive',
    health,
    parts: finalParts,
    text: toText(finalParts),
  };
}

/** Newest first by log position, as the API sends them. */
export const feedItems = (activities: Activity[]): FeedItem[] =>
  [...activities].sort((x, y) => y.seq - x.seq).map(feedItem);
