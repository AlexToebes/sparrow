export type CapacityUnit = 'GB' | 'TB';

const FACTOR: Record<CapacityUnit, number> = { GB: 1e9, TB: 1e12 };

/** Decimal units (D4): "1.92" TB gives 1_920_000_000_000 bytes. Returns null for blank input, NaN for junk. */
export function parseCapacity(text: string, unit: CapacityUnit): number | null {
  const t = text.trim().replace(',', '.');
  if (t === '') return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return Number.NaN;
  return Math.round(Number(t) * FACTOR[unit]);
}

/** Splits stored bytes into an editable number and unit: TB when it is at least 1 TB, else GB. */
export function splitCapacity(bytes: number | null): { text: string; unit: CapacityUnit } {
  if (bytes === null) return { text: '', unit: 'TB' };
  const unit: CapacityUnit = bytes >= 1e12 ? 'TB' : 'GB';
  return { text: String(Number((bytes / FACTOR[unit]).toPrecision(12))), unit };
}
