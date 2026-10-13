import { useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  installationSchema,
  poolSchema,
  type ChangeMembershipInput,
  type CreatePoolInput,
  type JoinPoolInput,
  type UpdatePoolInput,
} from '@sparrow/shared';
import { apiSend } from './client';

/** Pools and pool membership feed the layout badges, drive detail and life story. */
function useInvalidatePools() {
  const qc = useQueryClient();
  return () =>
    Promise.all(
      [['pools'], ['drives'], ['layout'], ['assignment-defaults'], ['activities']].map((queryKey) =>
        qc.invalidateQueries({ queryKey }),
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

/** 409 while a drive is installed in the pool (R29); the message says so. */
export function useDeletePool(poolId: string) {
  const invalidate = useInvalidatePools();
  return useMutation({
    mutationFn: () => apiSend('DELETE', `/api/pools/${poolId}`, undefined, z.undefined()),
    onSuccess: invalidate,
  });
}

export function useJoinPool(driveId: string) {
  const invalidate = useInvalidatePools();
  return useMutation({
    mutationFn: (input: JoinPoolInput) =>
      apiSend('POST', `/api/drives/${driveId}/membership`, input, installationSchema),
    onSuccess: invalidate,
  });
}

export function useChangeMembership(driveId: string) {
  const invalidate = useInvalidatePools();
  return useMutation({
    mutationFn: (input: ChangeMembershipInput) =>
      apiSend('PATCH', `/api/drives/${driveId}/membership`, input, installationSchema),
    onSuccess: invalidate,
  });
}

export function useLeavePool(driveId: string) {
  const invalidate = useInvalidatePools();
  return useMutation({
    mutationFn: () =>
      apiSend('DELETE', `/api/drives/${driveId}/membership`, {}, installationSchema),
    onSuccess: invalidate,
  });
}
