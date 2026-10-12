import { Alert } from '@mantine/core';
import { useProviderStatus, useSlotStatus } from '../api/hooks';
import { formatRelative } from '../lib/format';
import { providerName } from './ProviderStatusLine';

/** Newest timestamp among the given ISO strings, or null. */
export function newestReport(times: (string | null)[]): string | null {
  let best: string | null = null;
  for (const t of times) if (t && (best === null || Date.parse(t) > Date.parse(best))) best = t;
  return best;
}

/** R47: when the provider's data is stale or unreachable, one banner replaces per-slot flags. */
export function ProviderBanner() {
  const status = useSlotStatus();
  const provider = useProviderStatus();
  const id = provider.data?.providerId ?? status.data?.providerId;
  if (!id || id === 'none') return null;
  const name = providerName(id);
  if (provider.data && !provider.data.reachable && provider.data.lastAttemptAt) {
    return (
      <Alert color="yellow" title={`Cannot reach ${name}`} className="banner" role="alert">
        Showing the last known data
        {provider.data.lastSuccessAt ? ` from ${formatRelative(provider.data.lastSuccessAt)}` : ''}.
        Your layout and drive records are unaffected.
      </Alert>
    );
  }
  if (status.data?.providerStale) {
    // The newest observation's report time, not the last successful poll: polling can succeed
    // while the provider itself reports nothing new (R47).
    const newest = newestReport(status.data.slots.map((s) => s.lastReportedAt));
    return (
      <Alert color="yellow" title={`${name} data is out of date`} className="banner" role="alert">
        Nothing new has been reported
        {newest ? ` since ${formatRelative(newest)}` : ''}. Health shown is the last known value.
      </Alert>
    );
  }
  return null;
}
