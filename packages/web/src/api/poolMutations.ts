import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  membershipSchema,
  poolSchema,
  type ChangeMembershipInput,
  type CreatePoolInput,
  type JoinPoolInput,
  type UpdatePoolInput,
} from '@sparrow/shared';
import { apiGet, apiSend } from './client';

/** Pools and memberships feed the layout badges, drive detail and life story. */
function useInvalidatePools() {
  const qc = useQueryClient();
  return () =>
    Promise.all(
      [['pools'], ['drives'], ['layout'], ['memberships'], ['assignment-defaults']].map(
        (queryKey) => qc.invalidateQueries({ queryKey }),
      ),
    );
}

export function useCreatePool() {
  const invalidate = useInvalidatePools();
  return useMutation({
    mutationFn: (input: CreatePoolInput) => apiSend('POST', '/api/pools', input, poolSchema),
    onSuccess: invalidate,
  });
}

export function useUpdatePool(poolId: string) {
  const invalidate = useInvalidatePools();
  return useMutation({
    mutationFn: (input: UpdatePoolInput) =>
      apiSend('PATCH', `/api/pools/${poolId}`, input, poolSchema),
    onSuccess: invalidate,
  });
}

/** 409 once the pool has membership history (R29); the message says so. */
export function useDeletePool(poolId: string) {
  const invalidate = useInvalidatePools();
  return useMutation({
    mutationFn: () => apiSend('DELETE', `/api/pools/${poolId}`, undefined, z.undefined()),
    onSuccess: invalidate,
  });
}

const membershipsSchema = z.array(membershipSchema);

/** Full membership history of a drive, newest first (R29, R36). */
export const useMemberships = (driveId: string) =>
  useQuery({
    queryKey: ['memberships', driveId],
    queryFn: () => apiGet(`/api/drives/${driveId}/memberships`, membershipsSchema),
  });

export function useJoinPool(driveId: string) {
  const invalidate = useInvalidatePools();
  return useMutation({
    mutationFn: (input: JoinPoolInput) =>
      apiSend('POST', `/api/drives/${driveId}/membership`, input, membershipSchema),
    onSuccess: invalidate,
  });
}

export function useChangeMembership(driveId: string) {
  const invalidate = useInvalidatePools();
  return useMutation({
    mutationFn: (input: ChangeMembershipInput) =>
      apiSend('PATCH', `/api/drives/${driveId}/membership`, input, membershipSchema),
    onSuccess: invalidate,
  });
}

export function useLeavePool(driveId: string) {
  const invalidate = useInvalidatePools();
  return useMutation({
    mutationFn: () => apiSend('DELETE', `/api/drives/${driveId}/membership`, {}, membershipSchema),
    onSuccess: invalidate,
  });
}
