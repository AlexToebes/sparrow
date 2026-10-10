import { describe, expect, it } from 'vitest';
import { parseCapacity, splitCapacity } from '../src/lib/capacity';

describe('capacity entry (D4, decimal units)', () => {
  it('parses TB and GB to bytes', () => {
    expect(parseCapacity('4', 'TB')).toBe(4e12);
    expect(parseCapacity('1.92', 'TB')).toBe(1.92e12);
    expect(parseCapacity('500', 'GB')).toBe(5e11);
    expect(parseCapacity('1,5', 'TB')).toBe(1.5e12);
  });
  it('blank is null and junk is NaN', () => {
    expect(parseCapacity('  ', 'TB')).toBeNull();
    expect(parseCapacity('abc', 'TB')).toBeNaN();
    expect(parseCapacity('-1', 'TB')).toBeNaN();
  });
  it('splits stored bytes back for editing', () => {
    expect(splitCapacity(1.92e12)).toEqual({ text: '1.92', unit: 'TB' });
    expect(splitCapacity(5e11)).toEqual({ text: '500', unit: 'GB' });
    expect(splitCapacity(null)).toEqual({ text: '', unit: 'TB' });
  });
});
