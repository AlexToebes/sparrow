import { useState } from 'react';
import { Link } from 'react-router';
import { Badge, Button, Skeleton, Text } from '@mantine/core';
import type { Drive, DriveConflictView } from '@sparrow/shared';
import { useDriveConflicts, useRemoveConflict } from '../api/conflictMutations';
import { formatBytes } from '../lib/format';
import { AddConflictDialog } from './AddConflictDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { AlertTriangleIcon, PlusIcon } from './icons';

const STATUS_WORD = { spare: 'Spare', installed: 'Installed', retired: 'Retired' } as const;

/**
 * R78: the drives this one is not recommended together with (same batch, same purchase, same failure
 * history), with a way to add and remove pairs. Advice only: nothing here blocks an action. A pair is
 * shown from both drives; retired drives can be paired and keep their pairs.
 */
export function ConflictsSection({ drive }: { drive: Drive }) {
  const conflicts = useDriveConflicts(drive.id);
  const remove = useRemoveConflict(drive.id);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<DriveConflictView | null>(null);
  const list = conflicts.data ?? [];

  return (
    <section aria-label="Not recommended with" className="conflicts">
      <div className="conflicts-head">
        <h3 className="section-title">Not recommended with</h3>
        <Button
          size="compact-md"
          variant="light"
          leftSection={<PlusIcon size={14} />}
          onClick={() => setAdding(true)}
        >
          Add
        </Button>
      </div>
      <Text size="sm" c="dimmed" mb="xs">
        Drives you would rather not run in the same pool, for example from the same batch. Advice
        only.
      </Text>
      {conflicts.isPending ? <Skeleton height={44} radius="md" /> : null}
      {conflicts.isError ? (
        <Text c="red" size="sm">
          Could not load the list.
        </Text>
      ) : null}
      {conflicts.isSuccess && list.length === 0 ? (
        <Text size="sm" c="dimmed">
          None.
        </Text>
      ) : null}
      {list.length > 0 ? (
        <ul className="conflict-list" aria-label="Drives not recommended with this one">
          {list.map((c) => (
            <li key={c.otherDriveId} className="conflict-item">
              <div className="conflict-main">
                <div className="conflict-top">
                  <Link
                    to={`/drives?drive=${encodeURIComponent(c.otherDriveId)}`}
                    className="mono conflict-serial"
                  >
                    {c.serial}
                  </Link>
                  <Badge variant="light" color={c.status === 'retired' ? 'gray' : 'indigo'}>
                    {STATUS_WORD[c.status]}
                  </Badge>
                </div>
                <div className="dim conflict-meta">
                  {[c.model, formatBytes(c.capacityBytes) || null, c.where]
                    .filter(Boolean)
                    .join(' · ') || 'No details recorded'}
                </div>
                <div className="conflict-reason">
                  {c.reason ? (
                    <>
                      <AlertTriangleIcon size={13} /> {c.reason}
                    </>
                  ) : (
                    <span className="dim">No reason given</span>
                  )}
                </div>
              </div>
              <Button
                size="compact-md"
                variant="light"
                color="red"
                aria-label={`Remove ${c.serial} from not recommended with`}
                onClick={() => setRemoving(c)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {adding ? (
        <AddConflictDialog drive={drive} existing={list} onClose={() => setAdding(false)} />
      ) : null}
      {removing ? (
        <ConfirmDialog
          title="Remove pairing"
          confirmLabel="Remove"
          color="red"
          mutation={remove}
          body={removing.otherDriveId}
          onClose={() => setRemoving(null)}
        >
          <Text>
            Stop treating <strong className="mono">{drive.serial}</strong> and{' '}
            <strong className="mono">{removing.serial}</strong> as not recommended together?
            {removing.reason ? ` (Reason: ${removing.reason}.)` : ''} The history keeps the change.
          </Text>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
