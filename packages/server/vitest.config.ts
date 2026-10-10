import { defineConfig } from 'vitest/config';

// Tests run against TS source via the "source" export condition, so no build is needed first.
export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
});
