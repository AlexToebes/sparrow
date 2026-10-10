import { describe, expect, it } from 'vitest';
import { PROJECT_NAME } from '../src/index.js';

describe('shared', () => {
  it('exposes the project name (D12)', () => {
    expect(PROJECT_NAME).toBe('Sparrow');
  });
});
