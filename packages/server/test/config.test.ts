import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

// R16, R19, R28, N1: environment configuration.
describe('config', () => {
  it('applies defaults', () => {
    expect(loadConfig({})).toEqual({
      DATA_DIR: '/data',
      PORT: 3000,
      HOST: '0.0.0.0',
      PROVIDER: 'none',
      POLL_INTERVAL_MINUTES: 5,
    });
  });
  it('parses env overrides', () => {
    expect(loadConfig({ DATA_DIR: '/x', PORT: '8080', HOST: '127.0.0.1' })).toEqual({
      DATA_DIR: '/x',
      PORT: 8080,
      HOST: '127.0.0.1',
      PROVIDER: 'none',
      POLL_INTERVAL_MINUTES: 5,
    });
  });
  it('N1: ALLOWED_HOSTS is a comma list, lowercased; empty or unset means allow all', () => {
    expect(loadConfig({ ALLOWED_HOSTS: ' Sparrow.lan, nas:3000,' }).ALLOWED_HOSTS).toEqual([
      'sparrow.lan',
      'nas:3000',
    ]);
    expect(loadConfig({ ALLOWED_HOSTS: '' }).ALLOWED_HOSTS).toBeUndefined();
    expect(loadConfig({}).ALLOWED_HOSTS).toBeUndefined();
  });
  it('rejects an invalid port', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow();
  });
});
