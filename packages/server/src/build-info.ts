import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface BuildInfo {
  version: string;
  commit: string;
}

/** Same relative path from src/ (dev, tests) and dist/ (build, image): the server's package.json. */
const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url));

/**
 * Version: the server package.json (single source). Commit: GIT_COMMIT, set by the image build
 * (docker build-arg, from CI); "unknown" when unset, as in local dev and tests. No git calls.
 */
export function loadBuildInfo(env: Record<string, string | undefined> = process.env): BuildInfo {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { version?: string };
  return { version: pkg.version ?? 'unknown', commit: env.GIT_COMMIT?.trim() || 'unknown' };
}
