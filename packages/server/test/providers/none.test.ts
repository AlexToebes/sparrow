import { describe, expect, it } from 'vitest';
import { createProvider } from '../../src/providers/index.js';
import { runProviderContract } from './contract.js';
import { createNoneProvider } from '../../src/providers/none/index.js';

runProviderContract('none', createNoneProvider, () => ({
  ...createNoneProvider(),
  checkConnection: async () => ({ ok: false, error: 'down' }),
}));

describe('provider registry', () => {
  it('creates none and lists valid names for unknown providers', () => {
    expect(createProvider('none', {}).id).toBe('none');
    expect(() => createProvider('bogus', {})).toThrow(/Valid providers: none/);
  });
});
