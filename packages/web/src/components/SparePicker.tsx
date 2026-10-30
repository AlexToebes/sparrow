import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Text, TextInput } from '@mantine/core';
import type {
  CompatibilityVerdict,
  Drive,
  DriveStatus,
  SlotCompatibility,
  SpareCompatibility,
} from '@sparrow/shared';
import { spareConflictText } from '@sparrow/shared';
import { formatBytes } from '../lib/format';
import { AlertTriangleIcon, CheckIcon, HelpCircleIcon, XCircleIcon } from './icons';

interface SparePickerProps {
  spares: Drive[];
  value: string | null;
  onChange: (driveId: string) => void;
  label?: string;
  loading?: boolean;
  /**
   * R12: the verdict for every spare against the bay it would go into (GET /api/slots/:id/compatibility).
   * Each card gets a badge and the spares that fit come first. Advice only: every card stays selectable.
   * Leave it out when the picker is not choosing for a bay.
   */
  compatibility?: SlotCompatibility | null;
  /**
   * Which statuses are offered (default: spares only). The inbox's "Link to a drive" (R22) also
   * offers installed drives; only the pairing of drives not recommended together (R78) asks for
   * retired ones too.
   */
  statuses?: readonly DriveStatus[];
  /** Where each installed drive sits, by slot id (a card shows "In <bay>"). */
  bayLabels?: ReadonlyMap<string, string>;
  /** Plural noun for the search box and the empty states; default "spares". */
  noun?: string;
}

const SPARES_ONLY: readonly DriveStatus[] = ['spare'];

const VERDICT_RANK: Record<CompatibilityVerdict, number> = {
  fits: 0,
  unknown: 1,
  'too-small': 2,
  'different-type': 3,
};

/** R12: icon plus words (never color alone) for one verdict. */
export function verdictBadge(v: SpareCompatibility): { text: string; kind: CompatibilityVerdict } {
  switch (v.verdict) {
    case 'fits':
      return { text: 'Fits', kind: 'fits' };
    case 'too-small':
      return {
        text: v.neededBytes ? `Too small · needs ≥ ${formatBytes(v.neededBytes)}` : 'Too small',
        kind: 'too-small',
      };
    case 'different-type':
      return { text: 'Different type', kind: 'different-type' };
    default:
      return { text: 'Unknown size', kind: 'unknown' };
  }
}

function BadgeIcon({ kind }: { kind: CompatibilityVerdict }) {
  if (kind === 'fits') return <CheckIcon size={12} />;
  if (kind === 'unknown') return <HelpCircleIcon size={12} />;
  if (kind === 'too-small') return <AlertTriangleIcon size={12} />;
  return <XCircleIcon size={12} />;
}

/** Spares as selectable cards (R8): serial, model, capacity, condition, shelf location. Retired drives are never offered. */
export function SparePicker({
  spares,
  value,
  onChange,
  label = 'Spare drive',
  loading = false,
  compatibility = null,
  statuses = SPARES_ONLY,
  bayLabels,
  noun = 'spares',
}: SparePickerProps) {
  const [query, setQuery] = useState('');
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const verdictById = useMemo(
    () => new Map((compatibility?.spares ?? []).map((v) => [v.driveId, v])),
    [compatibility],
  );
  const offered = useMemo(() => {
    const list = spares.filter((d) => statuses.includes(d.status));
    if (verdictById.size === 0) return list;
    // R12: fits first (closest size first), then unknown, too small, different type; otherwise as given.
    // R78: within one verdict, spares not recommended with a pool member come after the others.
    const rank = (d: Drive) => VERDICT_RANK[verdictById.get(d.id)?.verdict ?? 'unknown'];
    const conflicting = (d: Drive) => ((verdictById.get(d.id)?.conflicts.length ?? 0) > 0 ? 1 : 0);
    return list
      .map((d, i) => ({ d, i }))
      .sort(
        (x, y) =>
          rank(x.d) - rank(y.d) ||
          conflicting(x.d) - conflicting(y.d) ||
          (rank(x.d) === 0 ? (x.d.capacityBytes ?? 0) - (y.d.capacityBytes ?? 0) : 0) ||
          x.i - y.i,
      )
      .map((x) => x.d);
  }, [spares, verdictById, statuses]);
  const q = query.trim().toLowerCase();
  const shown = q
    ? offered.filter((d) =>
        [d.serial, d.model, d.storageLocation, d.condition]
          .filter(Boolean)
          .some((f) => f!.toLowerCase().includes(q)),
      )
    : offered;
  const tabbable = shown.some((d) => d.id === value) ? value : (shown[0]?.id ?? null);

  const move = (e: KeyboardEvent, index: number) => {
    let target: Drive | undefined;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') target = shown[index + 1];
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') target = shown[index - 1];
    else if (e.key === 'Home') target = shown[0];
    else if (e.key === 'End') target = shown[shown.length - 1];
    else return;
    e.preventDefault();
    if (!target) return;
    onChange(target.id);
    refs.current.get(target.id)?.focus();
  };

  return (
    <div className="spare-picker">
      <TextInput
        placeholder="Search serial, model or location"
        aria-label={`Search ${noun}`}
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
      />
      {offered.length === 0 ? (
        <Text c="dimmed" size="sm">
          {loading
            ? `Loading ${noun}…`
            : statuses.includes('installed')
              ? `No ${noun} to link.`
              : 'No spares on the shelf.'}
        </Text>
      ) : shown.length === 0 ? (
        <Text c="dimmed" size="sm">
          No {noun.replace(/s$/, '')} matches “{query}”.
        </Text>
      ) : (
        <div className="spare-list" role="radiogroup" aria-label={label}>
          {shown.map((d, i) => {
            const selected = d.id === value;
            const capacity = formatBytes(d.capacityBytes);
            const verdict = verdictById.get(d.id);
            const badge = verdict ? verdictBadge(verdict) : null;
            return (
              <button
                key={d.id}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={d.id === tabbable ? 0 : -1}
                ref={(el) => {
                  if (el) refs.current.set(d.id, el);
                  else refs.current.delete(d.id);
                }}
                className="spare-card"
                data-selected={selected ? 'true' : undefined}
                onClick={() => onChange(d.id)}
                onKeyDown={(e) => move(e, i)}
              >
                <span className="spare-card-top">
                  <span className="mono">
                    <strong>{d.serial}</strong>
                  </span>
                  <span className="spare-card-cap">
                    <span className="mono">{capacity}</span>
                    {selected ? (
                      <span className="pick-check">
                        <CheckIcon size={12} />
                      </span>
                    ) : null}
                  </span>
                </span>
                <span className="spare-card-meta">
                  {[
                    d.model,
                    d.condition,
                    d.status === 'installed'
                      ? `In ${(d.slotId && bayLabels?.get(d.slotId)) || 'a bay'}`
                      : d.status === 'retired'
                        ? 'Retired'
                        : d.storageLocation
                          ? `On the shelf: ${d.storageLocation}`
                          : 'On the shelf',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {badge ? (
                  <span className="spare-tag" data-kind={badge.kind} title={verdict?.reason}>
                    <BadgeIcon kind={badge.kind} /> {badge.text}
                  </span>
                ) : null}
                {/* R78: advice beside the verdict (icon and words), never part of it. */}
                {verdict?.conflicts.map((c) => (
                  <span key={c.driveId} className="spare-conflict">
                    <AlertTriangleIcon size={12} /> {spareConflictText(c)}
                  </span>
                ))}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
