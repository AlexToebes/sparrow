import type { Health, LayoutSlot, SlotStatus, Drive } from '@sparrow/shared';
import { formatRelative } from './format';

export type SlotState = 'empty' | 'missing' | 'stale' | Health;

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
  /** The visible status word: "Healthy", "Missing", "Stale", "Empty". */
  word: string;
  /** Second line: missing reason, or "Healthy, seen 3 d ago" for stale. */
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
    return { ...base, state: 'empty', health: 'unknown', word: 'Empty', note: null };
  }
  const health: Health = status?.health ?? 'unknown';
  if (status?.flag) {
    return {
      ...base,
      state: 'missing',
      health,
      word: 'Missing',
      note: MISSING_REASON[status.flag.reason],
    };
  }
  if (status?.stale) {
    return {
      ...base,
      state: 'stale',
      health,
      word: 'Stale',
      note: `${HEALTH_WORD[health]}, seen ${formatRelative(status.lastReportedAt, now)}`,
    };
  }
  return { ...base, state: health, health, word: HEALTH_WORD[health], note: null };
}
