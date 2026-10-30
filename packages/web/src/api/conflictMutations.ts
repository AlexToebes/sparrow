import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { driveConflictViewSchema, driveConflictViewsSchema } from '@sparrow/shared';
import { apiGet, apiSend } from './client';

// R78: drives that are not recommended together. The pairs of one drive are read from the server;
// adding or removing one changes advice on pool cards and in the spare picker, and writes one activity.

/** The pairs a drive is in, seen from that drive. Keyed under 'drives' so a drive change refreshes it. */
export const useDriveConflicts = (driveId: string) =>
  useQuery({
    queryKey: ['drives', driveId, 'conflicts'] as const,
    queryFn: () => apiGet(`/api/drives/${driveId}/conflicts`, driveConflictViewsSchema),
  });

function useInvalidateConflicts() {
  const qc = useQueryClient();
  return () =>
    Promise.all(
      // Pool cards (warnings), the spare picker (compatibility notes), drive history and the feed.
      [['drives'], ['pools'], ['slots'], ['activities']].map((queryKey) =>
        qc.invalidateQueries({ queryKey }),
      ),
    );
}

export function useAddConflict(driveId: string) {
  const invalidate = useInvalidateConflicts();
  return useMutation({
    mutationFn: (input: { otherDriveId: string; reason?: string | null }) =>
      apiSend('POST', `/api/drives/${driveId}/conflicts`, input, driveConflictViewSchema),
    onSuccess: invalidate,
  });
}

/** The variable is the other drive's id. */
export function useRemoveConflict(driveId: string) {
  const invalidate = useInvalidateConflicts();
  return useMutation({
    mutationFn: (otherDriveId: string) =>
      apiSend(
        'DELETE',
        `/api/drives/${driveId}/conflicts/${encodeURIComponent(otherDriveId)}`,
        undefined,
        z.undefined(),
      ),
    onSuccess: invalidate,
  });
}
