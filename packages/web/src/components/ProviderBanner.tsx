import { Alert } from '@mantine/core';
import { useProviderStatus, useSlotStatus } from '../api/hooks';
import { formatRelative } from '../lib/format';
import { providerName } from './ProviderStatusLine';

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
    return (
      <Alert color="yellow" title={`${name} data is out of date`} className="banner" role="alert">
        Nothing new has been reported
        {status.data.lastSuccessAt ? ` since ${formatRelative(status.data.lastSuccessAt)}` : ''}.
        Health shown is the last known value.
      </Alert>
    );
  }
  return null;
}
