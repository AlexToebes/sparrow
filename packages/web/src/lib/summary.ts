import type { SlotView } from './health';

export interface Problem {
  slotId: string;
  kind: 'failed' | 'warning' | 'missing' | 'stale';
  text: string;
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

/** Chips for slots that need a look. Stale is left out when the whole provider is stale (R47). */
export function collectProblems(
  views: SlotView[],
  providerStale: boolean,
  staleText: (v: SlotView) => string,
): Problem[] {
  const order = { failed: 0, warning: 1, missing: 2, stale: 3 } as const;
  const out: Problem[] = [];
  for (const v of views) {
    if (v.state === 'failed')
      out.push({ slotId: v.slotId, kind: 'failed', text: `${v.label} failed` });
    else if (v.state === 'warning')
      out.push({ slotId: v.slotId, kind: 'warning', text: `${v.label} warning` });
    else if (v.state === 'missing')
      out.push({ slotId: v.slotId, kind: 'missing', text: `${v.label} missing` });
    else if (v.state === 'stale' && !providerStale)
      out.push({ slotId: v.slotId, kind: 'stale', text: `${v.label} ${staleText(v)}` });
  }
  return out.sort((a, b) => order[a.kind] - order[b.kind]);
}

export function summarySentence(problemCount: number, hasHealthData: boolean): string {
  if (problemCount === 0) return hasHealthData ? 'Everything is healthy' : 'Everything is in place';
  const word = problemCount <= 10 ? WORDS[problemCount]! : String(problemCount);
  return problemCount === 1 ? `${word} thing needs a look` : `${word} things need a look`;
}
