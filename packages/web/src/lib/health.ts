import type { Health, LayoutSlot, SlotStatus, Drive } from '@sparrow/shared';
import { formatRelative } from './format';

/** What a tile is: a stale drive keeps its last known health state (R18, R47); staleness is `SlotView.stale`. */
export type SlotState = 'empty' | 'missing' | Health;

export const HEALTH_WORD: Record<Health, string> = {
  ok: 'Healthy',
  warning: 'Warning',
  failed: 'Failed',
  unknown: 'No data',
};

const MISSING_REASON: Record<'decommissioned' | 'stale' | 'not-reported', string> = {
  decommissioned: 'Decommissioned',
  stale: 'Not seen lately',
  'not-reported': 'Not reported',
};

export interface SlotView {
  slotId: string;
  /** Slot label, or "Slot N" (1-based position) when it has none. */
  label: string;
  position: number;
  state: SlotState;
  /** Last known health (reported even when stale). */
  health: Health;
  /** True when the provider data for this drive is old; `state`/`word` still show the last known health. */
  stale: boolean;
  /** The visible status word: "Healthy", "Failed", "Missing", "Empty" (last known health when stale). */
  word: string;
  /** Second line: missing reason, or "Stale, seen 3 d ago" for stale. */
  note: string | null;
  drive: Drive | null;
  status: SlotStatus | null;
}

export function slotLabel(slot: Pick<LayoutSlot, 'label' | 'position'>): string {
  return slot.label ?? `Slot ${slot.position + 1}`;
}

/** Combines a slot, its drive and the computed status into what a tile shows (R18, R27, R47). */
export function buildSlotView(
  slot: LayoutSlot,
  drive: Drive | null,
  status: SlotStatus | null,
  now: number = Date.now(),
): SlotView {
  const base = { slotId: slot.id, label: slotLabel(slot), position: slot.position, drive, status };
  if (slot.driveId === null) {
    return { ...base, state: 'empty', health: 'unknown', stale: false, word: 'Empty', note: null };
  }
  const health: Health = status?.health ?? 'unknown';
  if (status?.flag) {
    return {
      ...base,
      state: 'missing',
      health,
      stale: false,
      word: 'Missing',
      note: MISSING_REASON[status.flag.reason],
    };
  }
  if (status?.stale) {
    return {
      ...base,
      state: health,
      health,
      stale: true,
      word: HEALTH_WORD[health],
      note: `Stale, seen ${formatRelative(status.lastReportedAt, now)}`,
    };
  }
  return { ...base, state: health, health, stale: false, word: HEALTH_WORD[health], note: null };
}
