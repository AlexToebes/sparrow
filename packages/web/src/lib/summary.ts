import type { SlotView } from './health';

export interface Problem {
  slotId: string;
  kind: 'failed' | 'warning' | 'missing' | 'stale';
  text: string;
  /** True when the health behind this chip is last known (stale), not fresh (R18, R47). */
  lastKnown: boolean;
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

/** "Front bays 3" when a slot label is only a number, so a chip never reads "3 missing". */
export function chipLabel(label: string, gridName: string | null | undefined): string {
  return /^\d+$/.test(label.trim()) && gridName ? `${gridName} ${label.trim()}` : label;
}

/**
 * Chips for slots that need a look. A stale drive keeps its last known failed/warning state and is
 * counted (worded "last known"); a stale drive whose last known health was fine gets a "stale" chip
 * only when the provider as a whole is not stale (R18, R47).
 */
export function collectProblems(
  views: SlotView[],
  providerStale: boolean,
  staleText: (v: SlotView) => string,
  nameOf: (v: SlotView) => string = (v) => v.label,
): Problem[] {
  const order = { failed: 0, warning: 1, missing: 2, stale: 3 } as const;
  const out: Problem[] = [];
  for (const v of views) {
    const name = nameOf(v);
    const known = v.stale ? ', last known' : '';
    if (v.state === 'failed')
      out.push({
        slotId: v.slotId,
        kind: 'failed',
        text: `${name} failed${known}`,
        lastKnown: v.stale,
      });
    else if (v.state === 'warning')
      out.push({
        slotId: v.slotId,
        kind: 'warning',
        text: `${name} warning${known}`,
        lastKnown: v.stale,
      });
    else if (v.state === 'missing')
      out.push({ slotId: v.slotId, kind: 'missing', text: `${name} missing`, lastKnown: false });
    else if (v.stale && !providerStale)
      out.push({
        slotId: v.slotId,
        kind: 'stale',
        text: `${name} ${staleText(v)}`,
        lastKnown: true,
      });
  }
  return out.sort((a, b) => order[a.kind] - order[b.kind]);
}

/** Never says "healthy" while any of the data behind it is stale (R18, R47). */
export function summarySentence(
  problemCount: number,
  hasHealthData: boolean,
  anyStale = false,
): string {
  if (problemCount === 0) {
    if (anyStale) return 'No problems known, but health data is out of date';
    return hasHealthData ? 'Everything is healthy' : 'Everything is in place';
  }
  const word = problemCount <= 10 ? WORDS[problemCount]! : String(problemCount);
  return problemCount === 1 ? `${word} thing needs a look` : `${word} things need a look`;
}
