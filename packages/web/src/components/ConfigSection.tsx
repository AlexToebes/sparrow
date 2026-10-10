import { Text } from '@mantine/core';
import { useProviderStatus } from '../api/hooks';
import { useConfig } from '../api/settings';
import { formatRelative } from '../lib/format';
import { ApiErrorAlert } from './ApiErrorAlert';

/** Settings > Configuration: read-only effective config (no secrets) plus provider reachability. */
export function ConfigSection() {
  const config = useConfig();
  const provider = useProviderStatus();
  const c = config.data;
  const p = provider.data;
  const rows: [string, React.ReactNode][] = [
    ['Provider', c ? <span className="mono">{c.provider}</span> : '...'],
    [
      'Provider status',
      p
        ? p.providerId === 'none'
          ? 'No provider (health data off)'
          : p.reachable
            ? 'Reachable'
            : `Unreachable${p.lastError ? `: ${p.lastError}` : ''}`
        : '...',
    ],
    ['Last updated', p ? (p.lastSuccessAt ? formatRelative(p.lastSuccessAt) : 'never') : '...'],
    ['Poll interval', c ? `${c.pollIntervalMinutes} min` : '...'],
    ['Stale after', c ? `${c.staleAfterHours} h` : '...'],
    ['Data directory', c ? <span className="mono">{c.dataDir}</span> : '...'],
    ['Backup directory', c ? <span className="mono">{c.backupDir}</span> : '...'],
  ];
  return (
    <section className="card" aria-labelledby="config-title">
      <div className="card-head">
        <h2 className="card-title" id="config-title">
          Configuration
        </h2>
      </div>
      <Text size="sm" c="dimmed" mb="md">
        Read only. These come from the container&apos;s environment variables.
      </Text>
      <ApiErrorAlert error={config.error} title="Could not load the configuration" />
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k} className="kv-row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
