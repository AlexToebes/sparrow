import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  type CreateEnclosureInput,
  type CreateGridInput,
  type UpdateGridInput,
} from '@sparrow/shared';
import { apiGet, apiSend } from './client';

/** GET /api/config: effective, read-only configuration (never secrets). */
export const configInfoSchema = z.object({
  provider: z.string(),
  pollIntervalMinutes: z.number(),
  staleAfterHours: z.number(),
  dataDir: z.string(),
  backupDir: z.string(),
});
export type ConfigInfo = z.infer<typeof configInfoSchema>;

/** POST /api/import result (R44). */
export const importResultSchema = z.object({
  backupPath: z.string(),
  counts: z.record(z.string(), z.number()),
});
export type ImportResult = z.infer<typeof importResultSchema>;

export const useConfig = () =>
  useQuery({ queryKey: ['config'], queryFn: () => apiGet('/api/config', configInfoSchema) });

const anything = z.unknown();

/** Layout edits change the grid, slot status and the occupants shown elsewhere: refetch all of it. */
function useInvalidateLayout() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['layout'] }),
      qc.invalidateQueries({ queryKey: ['status'] }),
      qc.invalidateQueries({ queryKey: ['drives'] }),
    ]);
}

export function useLayoutMutations() {
  const done = useInvalidateLayout();
  const opts = { onSuccess: done };
  return {
    createEnclosure: useMutation({
      mutationFn: (b: CreateEnclosureInput) => apiSend('POST', '/api/enclosures', b, anything),
      ...opts,
    }),
    renameEnclosure: useMutation({
      mutationFn: (v: { id: string; name: string }) =>
        apiSend('PATCH', `/api/enclosures/${v.id}`, { name: v.name }, anything),
      ...opts,
    }),
    deleteEnclosure: useMutation({
      mutationFn: (id: string) => apiSend('DELETE', `/api/enclosures/${id}`, undefined, anything),
      ...opts,
    }),
    createGrid: useMutation({
      mutationFn: (v: { enclosureId: string; body: CreateGridInput }) =>
        apiSend('POST', `/api/enclosures/${v.enclosureId}/grids`, v.body, anything),
      ...opts,
    }),
    updateGrid: useMutation({
      mutationFn: (v: { id: string; body: UpdateGridInput }) =>
        apiSend('PATCH', `/api/grids/${v.id}`, v.body, anything),
      ...opts,
    }),
    deleteGrid: useMutation({
      mutationFn: (id: string) => apiSend('DELETE', `/api/grids/${id}`, undefined, anything),
      ...opts,
    }),
    updateSlotLabel: useMutation({
      mutationFn: (v: { id: string; label: string }) =>
        apiSend('PATCH', `/api/slots/${v.id}`, { label: v.label }, anything),
      ...opts,
    }),
  };
}

export function useImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: unknown) => apiSend('POST', '/api/import', file, importResultSchema),
    // Everything in the database was replaced: drop every cached query.
    onSuccess: () => qc.invalidateQueries(),
  });
}
