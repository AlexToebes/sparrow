const UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'] as const;

/** Decimal units (D4): 1 TB = 10^12 bytes. formatBytes(4e12) === "4 TB", 1.92e12 gives "1.92 TB". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  let unit = 0;
  let value = bytes;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  // Three significant digits at most, no trailing zeros: 1.92 TB, 500 GB, 12 TB.
  const rounded = value >= 100 ? Math.round(value) : Number(value.toPrecision(3));
  return `${rounded} ${UNITS[unit]}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Short relative time for freshness: "just now", "2 min ago", "5 h ago", "3 d ago". */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'never';
  const diff = Math.max(0, now - then);
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  if (diff < 60 * DAY) return `${Math.floor(diff / DAY)} d ago`;
  return `${Math.floor(diff / (30 * DAY))} mo ago`;
}

/** Absolute date in the browser's local time zone (D3), for history. */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "1 y 7 mo", "28 d", "3 h", for spans of time in a drive's life story. */
export function formatDuration(ms: number): string {
  if (ms < DAY) return ms < HOUR ? 'under an hour' : `${Math.floor(ms / HOUR)} h`;
  const days = Math.floor(ms / DAY);
  if (days < 60) return `${days} d`;
  const months = Math.floor(days / 30.4375);
  if (months < 12) return `${months} mo`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest === 0 ? `${years} y` : `${years} y ${rest} mo`;
}
