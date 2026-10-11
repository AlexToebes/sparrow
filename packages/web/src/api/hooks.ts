import { useQueries, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import {
  driveSchema,
  eventSchema,
  driveSuggestionsResponseSchema,
  inboxResponseSchema,
  layoutSchema,
  statusResponseSchema,
  suggestionSummaryResponseSchema,
  type DriveStatus,
} from '@sparrow/shared';
import { apiGet } from './client';
import { poolDetailSchema, poolSummarySchema, providerStatusSchema } from './schemas';

const drivesSchema = z.array(driveSchema);
const eventsSchema = z.array(eventSchema);
const poolsSchema = z.array(poolSummarySchema);

export const queryKeys = {
  layout: ['layout'] as const,
  drives: (status?: DriveStatus) => ['drives', status ?? 'all'] as const,
  driveEvents: (id: string) => ['drives', id, 'events'] as const,
  inbox: ['inbox'] as const,
  providerStatus: ['provider-status'] as const,
  slotStatus: ['status'] as const,
  pools: ['pools'] as const,
  pool: (id: string) => ['pools', id] as const,
};

export const useLayout = () =>
  useQuery({ queryKey: queryKeys.layout, queryFn: () => apiGet('/api/layout', layoutSchema) });

export const useDrives = (status?: DriveStatus) =>
  useQuery({
    queryKey: queryKeys.drives(status),
    queryFn: () => apiGet(status ? `/api/drives?status=${status}` : '/api/drives', drivesSchema),
  });

/** Newest first, as the server returns them. */
export const useDriveEvents = (driveId: string | null) =>
  useQuery({
    queryKey: queryKeys.driveEvents(driveId ?? ''),
    queryFn: () => apiGet(`/api/drives/${driveId}/events`, eventsSchema),
    enabled: driveId !== null,
  });

export const useInbox = () =>
  useQuery({ queryKey: queryKeys.inbox, queryFn: () => apiGet('/api/inbox', inboxResponseSchema) });

export const useProviderStatus = () =>
  useQuery({
    queryKey: queryKeys.providerStatus,
    queryFn: () => apiGet('/api/provider/status', providerStatusSchema),
    refetchInterval: 60_000,
  });

/** GET /api/status (Step 8): per-slot health, staleness and missing flags. */
export const useSlotStatus = () =>
  useQuery({
    queryKey: queryKeys.slotStatus,
    queryFn: () => apiGet('/api/status', statusResponseSchema),
    refetchInterval: 60_000,
  });

export const usePools = () =>
  useQuery({ queryKey: queryKeys.pools, queryFn: () => apiGet('/api/pools', poolsSchema) });

export interface PoolBadgeInfo {
  poolId: string;
  poolName: string;
  layoutLabel: string | null;
  role: 'data' | 'hot-spare';
  /** Stable index of the pool in name order, for picking a color. */
  colorIndex: number;
}

/** Current pool of each drive, from the open memberships of every pool. Keyed by drive ID. */
export function useDrivePools(): Map<string, PoolBadgeInfo> {
  const pools = usePools();
  const details = useQueries({
    queries: (pools.data ?? []).map((p) => ({
      queryKey: queryKeys.pool(p.id),
      queryFn: () => apiGet(`/api/pools/${p.id}`, poolDetailSchema),
    })),
  });
  const map = new Map<string, PoolBadgeInfo>();
  details.forEach((d, colorIndex) => {
    if (!d.data) return;
    for (const m of d.data.members) {
      map.set(m.driveId, {
        poolId: d.data.id,
        poolName: d.data.name,
        layoutLabel: d.data.layoutLabel,
        role: m.role,
        colorIndex,
      });
    }
  });
  return map;
}

/**
 * R72: suggested updates for one drive. The keys start with 'drives', so any drive-changing
 * mutation (which invalidates ['drives']) refreshes them too.
 */
export const useDriveSuggestions = (driveId: string) =>
  useQuery({
    queryKey: ['drives', driveId, 'suggestions'] as const,
    queryFn: () =>
      apiGet(`/api/drives/${driveId}/suggestions`, driveSuggestionsResponseSchema).then(
        (r) => r.suggestions,
      ),
  });

/** R72: per-drive suggestion counts, for the Drives list and the Inbox page. */
export const useSuggestionSummary = () =>
  useQuery({
    queryKey: ['drives', 'suggestions'] as const,
    queryFn: () => apiGet('/api/suggestions', suggestionSummaryResponseSchema),
  });
