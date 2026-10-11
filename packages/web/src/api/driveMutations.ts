import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  assignDriveInputSchema,
  assignmentDefaultsSchema,
  dateSchema,
  driveSchema,
  occupantResolutionSchema,
  type AssignDriveInput,
  type CreateDriveInput,
  type OccupantResolution,
  type RetireDriveInput,
  type RmaInput,
  type UpdateDriveInput,
} from '@sparrow/shared';
import { apiGet, apiSend } from './client';

/**
 * R69: returning a drive to spares can carry the day it came out (null = "not recorded"; omitted =
 * the server uses today). Declared here so the web build does not depend on the shared schema
 * having caught up; it is a subtype of the shared one.
 */
export type OccupantInput = OccupantResolution | { action: 'spare'; removedOn?: string | null };
export type AssignBody = Omit<AssignDriveInput, 'occupant'> & { occupant?: OccupantInput };
export interface RemoveInput {
  note?: string | null;
  /** YYYY-MM-DD; null = not recorded; omitted = today (server). */
  removedOn?: string | null;
}

const occupantInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('spare'), removedOn: dateSchema.nullable().optional() }),
  occupantResolutionSchema.options[1],
  occupantResolutionSchema.options[2],
]);
const assignBodySchema = assignDriveInputSchema
  .omit({ occupant: true })
  .extend({ occupant: occupantInputSchema.optional() });

const assignResultSchema = z.object({ drive: driveSchema, occupant: driveSchema.optional() });

/** What the 409 for an occupied slot carries (R37): details.occupant. */
export function occupantFromError(details: unknown): { driveId: string; serial: string } | null {
  const parsed = z
    .object({ occupant: z.object({ driveId: z.string(), serial: z.string() }) })
    .safeParse(details);
  return parsed.success ? parsed.data.occupant : null;
}

/** R35: pool and role of the slot's current or last occupant, to prefill the assign form. */
export const useAssignmentDefaults = (slotId: string | null) =>
  useQuery({
    queryKey: ['assignment-defaults', slotId ?? ''],
    queryFn: () => apiGet(`/api/slots/${slotId}/assignment-defaults`, assignmentDefaultsSchema),
    enabled: slotId !== null,
    gcTime: 0,
  });

/** A lifecycle change touches the layout, spares, status, inbox and pool membership views. */
export function useInvalidateAll() {
  const qc = useQueryClient();
  return () =>
    Promise.all(
      [
        ['layout'],
        ['drives'],
        ['status'],
        ['inbox'],
        ['pools'],
        ['memberships'],
        ['assignment-defaults'],
      ].map((queryKey) => qc.invalidateQueries({ queryKey })),
    );
}

export function useCreateDrive() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (input: CreateDriveInput) => apiSend('POST', '/api/drives', input, driveSchema),
    onSuccess: invalidate,
  });
}

export function useUpdateDrive(driveId: string) {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (input: UpdateDriveInput) =>
      apiSend('PATCH', `/api/drives/${driveId}`, input, driveSchema),
    onSuccess: invalidate,
  });
}

export function useAssignDrive() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: ({ slotId, ...body }: AssignBody & { slotId: string }) =>
      apiSend(
        'POST',
        `/api/slots/${slotId}/assign`,
        assignBodySchema.parse(body),
        assignResultSchema,
      ),
    onSuccess: invalidate,
  });
}

type Action = 'remove' | 'retire' | 'rma' | 'reinstate';

export function useDriveAction(driveId: string, action: Action) {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (body: RetireDriveInput | RmaInput | RemoveInput) =>
      apiSend('POST', `/api/drives/${driveId}/${action}`, body, driveSchema),
    onSuccess: invalidate,
  });
}
