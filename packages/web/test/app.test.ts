import { describe, expect, it } from 'vitest';
import { APP_TITLE } from '../src/app.js';

describe('web', () => {
  it('has an app title', () => {
    expect(APP_TITLE).toBe('Sparrow');
  });
});
