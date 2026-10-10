import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * R53: no provider vocabulary outside providers/scrutiny/. The names below are the Scrutiny-specific
 * (snake_case or Scrutiny-only) keys seen in test/fixtures/scrutiny-summary.json. `wwn` itself is
 * excluded on purpose: the normalized observation has a `wwn` field (Appendix A), so it is not
 * distinctive. Generic keys such as form_factor (a legitimate DB column), `model_name`, `capacity`, `archived` are also too common to ban.
 */
const BANNED = [
  'device_status',
  'risk_category',
  'risk_score',
  'collector_date',
  'smart_support',
  'device_protocol',
  'device_type',
  'rotational_speed',
  'serial_number',
  'temp_history',
  'device_serial_id',
  'smart_display_mode',
  'has_forced_failure',
  'missed_ping_timeout_override',
];

const root = new URL('../../..', import.meta.url).pathname; // packages/
const scanRoots = ['server/src', 'shared/src', 'web/src'].map((p) => join(root, p));
const allowed = join(root, 'server/src/providers/scrutiny') + sep;

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : walk(p);
    return /\.(ts|tsx|js|json|sql|css|html)$/.test(name) ? [p] : [];
  });
}

describe('R53: no Scrutiny vocabulary outside providers/scrutiny', () => {
  const files = scanRoots
    .flatMap(walk)
    .filter((f) => !(f + sep).startsWith(allowed) && !f.startsWith(allowed));

  it('scans a non-trivial set of files', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('finds no banned Scrutiny field names', () => {
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const word of BANNED) {
        if (new RegExp(`\\b${word}\\b`).test(text)) hits.push(`${relative(root, f)}: ${word}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the banned list actually matches the fixture keys (guards against a stale list)', () => {
    const fixture = readFileSync(join(root, 'server/test/fixtures/scrutiny-summary.json'), 'utf8');
    for (const word of BANNED) expect(fixture, word).toContain(`"${word}"`);
  });
});
