import { useState } from 'react';
import { Button, Modal, Text, TextInput } from '@mantine/core';
import type { Drive } from '@sparrow/shared';
import { useUpdateDrive } from '../api/driveMutations';
import { ApiErrorAlert } from './ApiErrorAlert';
import { installedOnError, todayLocal } from './RetireFields';

/**
 * Edits the installation date of an installed drive (R68), for when it was recorded late.
 * The event log still records when the change was made. Mount only while open.
 */
export function InstalledOnDialog({ drive, onClose }: { drive: Drive; onClose: () => void }) {
  const update = useUpdateDrive(drive.id);
  const [value, setValue] = useState(drive.installedOn ?? '');
  const [problem, setProblem] = useState<string | null>(null);

  const save = () => {
    const bad = installedOnError(value);
    setProblem(bad);
    if (bad) return;
    const next = value === '' ? null : value;
    if (next === drive.installedOn) return onClose();
    update.mutate({ installedOn: next }, { onSuccess: onClose });
  };
  const clear = () => update.mutate({ installedOn: null }, { onSuccess: onClose });

  return (
    <Modal opened onClose={onClose} title="Installation date" centered>
      <Text size="sm">
        When did <strong className="mono">{drive.serial}</strong> go into its slot?
      </Text>
      <TextInput
        label="Installed on (optional)"
        description="Leave empty if you don’t know. The change is logged with today’s date."
        type="date"
        mt="sm"
        max={todayLocal()}
        value={value}
        onChange={(e) => setValue(e.currentTarget.value)}
        error={problem}
      />
      <ApiErrorAlert error={update.error} />
      <div className="dialog-actions">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        {drive.installedOn ? (
          <Button variant="default" onClick={clear} disabled={update.isPending}>
            Clear date
          </Button>
        ) : null}
        <Button onClick={save} loading={update.isPending}>
          Save
        </Button>
      </div>
    </Modal>
  );
}
