import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('config', () => {
  it('applies defaults', () => {
    expect(loadConfig({})).toEqual({ DATA_DIR: '/data', PORT: 3000, HOST: '0.0.0.0' });
  });
  it('parses env overrides', () => {
    expect(loadConfig({ DATA_DIR: '/x', PORT: '8080', HOST: '127.0.0.1' })).toEqual({
      DATA_DIR: '/x',
      PORT: 8080,
      HOST: '127.0.0.1',
    });
  });
  it('rejects an invalid port', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow();
  });
});
