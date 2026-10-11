import { useState, type ReactNode } from 'react';
import { Text } from '@mantine/core';
import type { Drive } from '@sparrow/shared';
import { useDriveAction } from '../api/driveMutations';
import { NOT_RECORDED_HINT, OptionalDateField } from './AssignFields';
import { ConfirmDialog } from './ConfirmDialog';
import { removedOnError, todayLocal } from './RetireFields';

interface RemoveToSparesDialogProps {
  drive: Drive;
  where: string | null;
  title?: string;
  confirmLabel?: string;
  /** R69: today when the drive is being taken out now; empty (not recorded) when it went missing at an unknown time. */
  defaultRemovedOn?: string;
  /** Extra sentence(s) after the question. */
  children?: ReactNode;
  onClose: () => void;
}

/**
 * Return a drive to the spares shelf with an optional removal date (R69). Empty sends an explicit
 * null (not recorded). The server's date errors (future, before the install or pool start) show
 * inline in the dialog. Mount only while open.
 */
export function RemoveToSparesDialog({
  drive,
  where,
  title = 'Remove to spares',
  confirmLabel = 'Remove to spares',
  defaultRemovedOn = todayLocal(),
  children,
  onClose,
}: RemoveToSparesDialogProps) {
  const remove = useDriveAction(drive.id, 'remove');
  const [removedOn, setRemovedOn] = useState(defaultRemovedOn);
  const problem = removedOnError(removedOn);
  return (
    <ConfirmDialog
      title={title}
      confirmLabel={confirmLabel}
      mutation={remove}
      body={{ removedOn: removedOn === '' ? null : removedOn }}
      confirmDisabled={problem !== null}
      onClose={onClose}
    >
      <Text>
        Move <strong className="mono">{drive.serial}</strong>
        {where ? ` out of ${where}` : ''} back to the spares shelf? {children} Its pool membership
        ends; its history is kept.
      </Text>
      <OptionalDateField
        label="Removed on (optional)"
        description={NOT_RECORDED_HINT}
        value={removedOn}
        onChange={setRemovedOn}
        error={problem}
      />
    </ConfirmDialog>
  );
}
