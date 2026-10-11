import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Text, TextInput } from '@mantine/core';
import type { Drive } from '@sparrow/shared';
import { formatBytes } from '../lib/format';
import { AlertTriangleIcon, CheckIcon } from './icons';

/** With more spares than this a search box appears. */
export const SPARE_SEARCH_THRESHOLD = 6;

interface SparePickerProps {
  spares: Drive[];
  value: string | null;
  onChange: (driveId: string) => void;
  label?: string;
  loading?: boolean;
  /**
   * The drive being replaced. Spares of the same type and at least its capacity are listed first
   * and tagged "Suggested"; smaller ones get a non-blocking note (R60). A light version of the
   * parking-lot sizing idea: no vdev-usable-size check.
   */
  outgoing?: Drive | null;
}

type Fit = 'suggested' | 'smaller' | 'neutral';

/** How a spare compares with the drive it would replace. */
export function fitFor(spare: Drive, outgoing: Drive | null | undefined): Fit {
  if (!outgoing) return 'neutral';
  const a = spare.capacityBytes;
  const b = outgoing.capacityBytes;
  if (a != null && b != null && a < b) return 'smaller';
  const typeOk = outgoing.driveType == null || spare.driveType === outgoing.driveType;
  return typeOk && a != null && b != null ? 'suggested' : 'neutral';
}

/** Spares as selectable cards (R8): serial, model, capacity, condition, shelf location. Retired drives are never offered. */
export function SparePicker({
  spares,
  value,
  onChange,
  label = 'Spare drive',
  loading = false,
  outgoing = null,
}: SparePickerProps) {
  const [query, setQuery] = useState('');
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const offered = useMemo(() => {
    const list = spares.filter((d) => d.status === 'spare');
    if (!outgoing) return list;
    // Suggested first (closest size first), then the rest in their given order.
    const rank = (d: Drive) => (fitFor(d, outgoing) === 'suggested' ? 0 : 1);
    return list
      .map((d, i) => ({ d, i }))
      .sort(
        (x, y) =>
          rank(x.d) - rank(y.d) ||
          (rank(x.d) === 0 ? (x.d.capacityBytes ?? 0) - (y.d.capacityBytes ?? 0) : 0) ||
          x.i - y.i,
      )
      .map((x) => x.d);
  }, [spares, outgoing]);
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
      {offered.length > SPARE_SEARCH_THRESHOLD ? (
        <TextInput
          placeholder="Search serial, model or location"
          aria-label="Search spares"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
      ) : null}
      {offered.length === 0 ? (
        <Text c="dimmed" size="sm">
          {loading ? 'Loading spares…' : 'No spares on the shelf.'}
        </Text>
      ) : shown.length === 0 ? (
        <Text c="dimmed" size="sm">
          No spare matches “{query}”.
        </Text>
      ) : (
        <div className="spare-list" role="radiogroup" aria-label={label}>
          {shown.map((d, i) => {
            const selected = d.id === value;
            const capacity = formatBytes(d.capacityBytes);
            const fit = fitFor(d, outgoing);
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
                    d.storageLocation ? `On the shelf: ${d.storageLocation}` : 'On the shelf',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {fit === 'suggested' ? (
                  <span className="spare-tag" data-kind="suggested">
                    <CheckIcon size={12} /> Suggested · Same type
                    {outgoing?.capacityBytes ? `, ≥ ${formatBytes(outgoing.capacityBytes)}` : ''}
                  </span>
                ) : null}
                {fit === 'smaller' ? (
                  <span className="spare-tag" data-kind="smaller">
                    <AlertTriangleIcon size={12} /> Smaller than the current drive ({capacity} vs{' '}
                    {formatBytes(outgoing?.capacityBytes ?? null)})
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
