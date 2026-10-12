import { Badge } from '@mantine/core';
import type { PoolBadgeInfo } from '../api/hooks';
import type { SlotView } from '../lib/health';
import { formatBytes } from '../lib/format';
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  ClockIcon,
  HelpCircleIcon,
  MissingIcon,
  PlusIcon,
  XCircleIcon,
} from './icons';

export const POOL_COLORS = ['grape', 'teal', 'orange', 'cyan', 'pink', 'lime'] as const;
export const poolColor = (index: number) => POOL_COLORS[index % POOL_COLORS.length];

/** `stale` is only used for the "stale" problem chip; tiles keep their last known health icon. */
export function StateIcon({
  state,
  size = 16,
}: {
  state: SlotView['state'] | 'stale';
  size?: number;
}) {
  switch (state) {
    case 'ok':
      return <CheckCircleIcon size={size} />;
    case 'warning':
      return <AlertTriangleIcon size={size} />;
    case 'failed':
      return <XCircleIcon size={size} />;
    case 'missing':
      return <MissingIcon size={size} />;
    case 'stale':
      return <ClockIcon size={size} />;
    case 'empty':
      return null;
    default:
      return <HelpCircleIcon size={size} />;
  }
}

interface SlotTileProps {
  view: SlotView;
  pool?: PoolBadgeInfo;
  selected?: boolean;
  onSelect: (slotId: string) => void;
}

/** One slot: label, health icon plus word (never color alone), capacity, serial, pool badge. */
export function SlotTile({ view, pool, selected, onSelect }: SlotTileProps) {
  const { drive } = view;
  const summary = [
    view.label,
    view.word,
    view.note,
    drive ? `${formatBytes(drive.capacityBytes)} ${drive.serial}`.trim() : null,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <button
      type="button"
      className="tile"
      data-state={view.state}
      data-stale={view.stale ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      aria-label={summary}
      aria-pressed={selected ?? false}
      onClick={() => onSelect(view.slotId)}
    >
      <span className="tile-top">
        <span className="tile-label">{view.label}</span>
        <span className="tile-icon">
          <StateIcon state={view.state} />
        </span>
      </span>
      <span className="tile-body">
        <span className="tile-word">{view.word}</span>
        {view.state === 'empty' ? (
          <span className="tile-assign">
            <PlusIcon size={12} /> Assign
          </span>
        ) : null}
        {view.note ? (
          <span className="tile-note">
            {view.stale ? <ClockIcon size={11} /> : null}
            {view.note}
          </span>
        ) : null}
        {drive?.capacityBytes != null ? (
          <span className="tile-meta">{formatBytes(drive.capacityBytes)}</span>
        ) : null}
        {drive ? <span className="tile-serial">{drive.serial}</span> : null}
        {pool ? (
          <Badge size="xs" variant="light" color={poolColor(pool.colorIndex)} className="tile-pool">
            {pool.poolName}
            {pool.role === 'hot-spare' ? ' · spare' : ''}
          </Badge>
        ) : null}
      </span>
    </button>
  );
}
