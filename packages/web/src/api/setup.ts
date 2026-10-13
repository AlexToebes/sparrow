import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { setupResultSchema, setupStateResponseSchema, type SetupInput } from '@sparrow/shared';
import { apiGet, apiSend } from './client';

/** R77: `needed` (show the wizard), `skipped` or `done`. */
export const useSetupState = () =>
  useQuery({
    queryKey: ['setup'] as const,
    queryFn: () => apiGet('/api/setup', setupStateResponseSchema),
  });

/** Creating the layout changes almost everything the app shows, so all cached data is refetched. */
function useRefetchAll() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
}

export function useCompleteSetup() {
  const refetch = useRefetchAll();
  return useMutation({
    mutationFn: (input: SetupInput) => apiSend('POST', '/api/setup', input, setupResultSchema),
    onSuccess: refetch,
  });
}

export function useSkipSetup() {
  const refetch = useRefetchAll();
  return useMutation({
    mutationFn: () => apiSend('POST', '/api/setup/skip', {}, setupStateResponseSchema),
    onSuccess: refetch,
  });
}
