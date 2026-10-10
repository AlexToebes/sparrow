import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, formatRelative } from '../src/lib/format';

describe('formatBytes (D4 decimal units)', () => {
  it('formats common drive sizes', () => {
    expect(formatBytes(4_000_000_000_000)).toBe('4 TB');
    expect(formatBytes(500_000_000_000)).toBe('500 GB');
    expect(formatBytes(1_920_000_000_000)).toBe('1.92 TB');
    expect(formatBytes(12_000_000_000_000)).toBe('12 TB');
    expect(formatBytes(960_000_000_000)).toBe('960 GB');
  });
  it('uses 1000, not 1024', () => {
    expect(formatBytes(1000)).toBe('1 kB');
    expect(formatBytes(1024)).toBe('1.02 kB');
    expect(formatBytes(999)).toBe('999 B');
  });
  it('returns an empty string without a capacity', () => {
    expect(formatBytes(null)).toBe('');
    expect(formatBytes(undefined)).toBe('');
  });
});

describe('relative time and durations', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  it('formats freshness', () => {
    expect(formatRelative('2026-10-10T11:58:00Z', now)).toBe('2 min ago');
    expect(formatRelative('2026-10-07T12:00:00Z', now)).toBe('3 d ago');
    expect(formatRelative(null, now)).toBe('never');
  });
  it('formats spans', () => {
    expect(formatDuration(28 * 86_400_000)).toBe('28 d');
    expect(formatDuration(580 * 86_400_000)).toBe('1 y 7 mo');
  });
});
