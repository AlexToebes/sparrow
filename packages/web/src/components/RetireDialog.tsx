import { useState } from 'react';
import { Alert, Button, Modal, Text } from '@mantine/core';
import type { Drive } from '@sparrow/shared';
import { useDriveAction } from '../api/driveMutations';
import { useDrives } from '../api/hooks';
import { ApiError } from '../api/client';
import {
  RetireFields,
  emptyRetireValues,
  retireValuesError,
  type RetireValues,
} from './RetireFields';

interface RetireDialogProps {
  drive: Drive;
  opened: boolean;
  onClose: () => void;
}

/** Retire a drive (R60, R61): reason, date, replaced-by with both capacities, note, then a confirm step. */
export function RetireDialog({ drive, opened, onClose }: RetireDialogProps) {
  const drives = useDrives();
  const retire = useDriveAction(drive.id, 'retire');
  const [values, setValues] = useState<RetireValues>(emptyRetireValues);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setValues(emptyRetireValues());
    setConfirming(false);
    setError(null);
    retire.reset();
    onClose();
  };

  const review = () => {
    const problem = retireValuesError(values);
    setError(problem);
    if (!problem) setConfirming(true);
  };

  const submit = () =>
    retire.mutate(
      {
        reason: values.reason!,
        date: values.date,
        replacedByDriveId: values.replacedByDriveId,
        note: values.note.trim() === '' ? null : values.note.trim(),
      },
      {
        onSuccess: close,
        onError: (e) => {
          setConfirming(false);
          setError(e instanceof ApiError ? e.message : 'Could not retire the drive.');
        },
      },
    );

  const candidates = (drives.data ?? []).filter((d) => d.id !== drive.id);
  const replacement = candidates.find((c) => c.id === values.replacedByDriveId);

  return (
    <Modal opened={opened} onClose={close} title={`Retire ${drive.serial}`} centered>
      {confirming ? (
        <>
          <Text>
            Retire <strong className="mono">{drive.serial}</strong> as {values.reason} on{' '}
            {values.date}
            {replacement ? `, replaced by ${replacement.serial}` : ''}?
          </Text>
          {drive.status === 'installed' ? (
            <Text size="sm" c="dimmed" mt="xs">
              It leaves its slot and its pool membership ends. Its history is kept.
            </Text>
          ) : null}
          {error ? (
            <Alert color="red" mt="sm">
              {error}
            </Alert>
          ) : null}
          <div className="dialog-actions">
            <Button variant="default" onClick={() => setConfirming(false)}>
              Back
            </Button>
            <Button color="red" loading={retire.isPending} onClick={submit}>
              Confirm retire
            </Button>
          </div>
        </>
      ) : (
        <>
          <RetireFields
            drive={drive}
            candidates={candidates}
            values={values}
            onChange={setValues}
          />
          {error ? (
            <Alert color="red" mt="sm">
              {error}
            </Alert>
          ) : null}
          <div className="dialog-actions">
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Button color="red" onClick={review}>
              Review
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
