import { observationSchema } from '@sparrow/shared';
import { describe, expect, it } from 'vitest';
import type { DriveDataProvider } from './port.js';

/**
 * Reusable suite every adapter must pass.
 *
 * Serial normalization contract: providers return serials trimmed and non-empty (or omit them).
 * Case-folding and other canonicalization is done by the core via `normalizeSerial`, not here.
 */
export function runProviderContract(
  name: string,
  makeProvider: () => DriveDataProvider,
  makeUnreachableProvider?: () => DriveDataProvider,
): void {
  describe(`provider contract: ${name}`, () => {
    it('has a non-empty, stable id', () => {
      const a = makeProvider();
      const b = makeProvider();
      expect(a.id.length).toBeGreaterThan(0);
      expect(a.id).toBe(b.id);
      expect(a.id).toBe(a.id);
    });

    it('declares capabilities and an update interval', () => {
      const p = makeProvider();
      expect(p.capabilities.drives).toBe(true);
      expect(typeof p.capabilities.pools).toBe('boolean');
      expect(p.expectedUpdateIntervalHours).toBeGreaterThan(0);
    });

    it('returns observations valid under the shared schema (an empty list is fine)', async () => {
      const list = await makeProvider().fetchSnapshot();
      expect(Array.isArray(list)).toBe(true);
      for (const o of list) expect(observationSchema.safeParse(o).success).toBe(true);
    });

    it('returns trimmed, non-empty serials', async () => {
      const list = await makeProvider().fetchSnapshot();
      for (const o of list) {
        if (o.serial !== undefined) {
          expect(o.serial.length).toBeGreaterThan(0);
          expect(o.serial).toBe(o.serial.trim());
        }
      }
    });

    it('checkConnection resolves with ok true or false and never rejects', async () => {
      const result = await makeProvider().checkConnection();
      expect(typeof result.ok).toBe('boolean');
      if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
    });

    if (makeUnreachableProvider) {
      it('reports an unreachable backend as { ok: false } instead of throwing', async () => {
        const result = await makeUnreachableProvider().checkConnection();
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
      });
    }
  });
}
