import { useProviderStatus } from '../api/hooks';
import { formatRelative } from '../lib/format';
import { useNow } from '../lib/useNow';

export function providerName(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** "Last updated 2 min ago" plus a provider status indicator (icon-free dot plus word). */
export function ProviderStatusLine() {
  const { data, isError } = useProviderStatus();
  const now = useNow();
  let dot: 'ok' | 'bad' | 'off' = 'off';
  let text = 'Checking provider';
  if (isError) {
    dot = 'bad';
    text = 'Server unreachable';
  } else if (data) {
    if (data.providerId === 'none') text = 'No provider';
    else if (data.reachable) {
      dot = 'ok';
      text = `${providerName(data.providerId)} reachable`;
    } else {
      dot = 'bad';
      text = `${providerName(data.providerId)} unreachable`;
    }
  }
  const updated =
    data && data.providerId !== 'none'
      ? `Last updated ${formatRelative(data.lastSuccessAt, now)}`
      : null;
  return (
    <div className="status-line">
      <span className="status-provider" data-dot={dot} title={data?.lastError ?? undefined}>
        <span className="status-dot" aria-hidden="true" />
        {text}
      </span>
      {updated ? <span className="status-updated">{updated}</span> : null}
    </div>
  );
}
