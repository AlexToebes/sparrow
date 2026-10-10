import { Alert } from '@mantine/core';
import { z } from 'zod';
import { ApiError } from '../api/client';
import { useDrives } from '../api/hooks';

const occupiedSchema = z.object({
  occupied: z.array(
    z.object({
      slotId: z.string(),
      gridName: z.string().optional(),
      position: z.number(),
      label: z.string().nullable().optional(),
      driveId: z.string().nullable().optional(),
    }),
  ),
});

/** Shows an API error readably; a blocked shrink or delete (R40) also lists the occupied slots. */
export function ApiErrorAlert({ error, title }: { error: unknown; title?: string }) {
  const drives = useDrives();
  if (!error) return null;
  const message = error instanceof Error ? error.message : 'Something went wrong';
  const occupied =
    error instanceof ApiError
      ? occupiedSchema.safeParse(error.details)
      : { success: false as const };
  const serial = (id: string | null | undefined) =>
    drives.data?.find((d) => d.id === id)?.serial ?? null;
  return (
    <Alert color="red" title={title ?? 'That did not work'} role="alert" mt="sm">
      <p style={{ margin: 0 }}>{message}</p>
      {occupied.success ? (
        <ul aria-label="Occupied slots" style={{ margin: '8px 0 0', paddingLeft: 20 }}>
          {occupied.data.occupied.map((o) => (
            <li key={o.slotId}>
              {o.gridName ? `${o.gridName}, ` : ''}
              {o.label ? o.label : `slot ${o.position + 1}`}
              {serial(o.driveId) ? (
                <>
                  {' '}
                  holds <span className="mono">{serial(o.driveId)}</span>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Alert>
  );
}
