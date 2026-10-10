import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';
import {
  driveSchema,
  type CreateFromObservationInput,
  type ImportRetiredInput,
  type LinkObservationInput,
} from '@sparrow/shared';
import { apiSend } from './client';
import { useInvalidateAll } from './driveMutations';

const placedSchema = z.object({ drive: driveSchema, occupant: driveSchema.optional() });
const importedSchema = z.array(driveSchema);

// Observation keys come from the provider and may hold characters that are not URL safe.
const keyPath = (key: string) => encodeURIComponent(key);

/** R22, R25: link an inbox observation to an existing spare and install it. */
export function useLinkObservation(observationKey: string) {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (input: LinkObservationInput) =>
      apiSend('POST', `/api/inbox/${keyPath(observationKey)}/link`, input, placedSchema),
    onSuccess: invalidate,
  });
}

/** R22, R23: create a drive record from an inbox observation and install it. */
export function useCreateFromObservation(observationKey: string) {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (input: CreateFromObservationInput) =>
      apiSend('POST', `/api/inbox/${keyPath(observationKey)}/create`, input, placedSchema),
    onSuccess: invalidate,
  });
}

/** R63: create records for decommissioned drives and retire them in one go. */
export function useImportRetired() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (input: ImportRetiredInput) =>
      apiSend('POST', '/api/inbox/import-retired', input, importedSchema),
    onSuccess: invalidate,
  });
}
