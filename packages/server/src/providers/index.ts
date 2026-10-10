import { createNoneProvider } from './none/index.js';
import type { DriveDataProvider } from './port.js';

export type { DriveDataProvider } from './port.js';

type Factory = (env: NodeJS.ProcessEnv) => DriveDataProvider;

// Adapter-specific env is parsed inside each adapter (R45). Step 5 adds 'scrutiny' here.
const factories: Record<string, Factory> = {
  none: () => createNoneProvider(),
};

export const PROVIDER_NAMES = Object.keys(factories);

export function createProvider(name: string, env: NodeJS.ProcessEnv): DriveDataProvider {
  const factory = Object.hasOwn(factories, name) ? factories[name] : undefined;
  if (!factory) {
    throw new Error(`Unknown PROVIDER "${name}". Valid providers: ${PROVIDER_NAMES.join(', ')}`);
  }
  return factory(env);
}
