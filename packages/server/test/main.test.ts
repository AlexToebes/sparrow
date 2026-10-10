import { describe, expect, it } from 'vitest';
import { SERVICE_NAME } from '../src/main.js';

describe('server', () => {
  it('has a service name', () => {
    expect(SERVICE_NAME).toBe('sparrow-server');
  });
});
