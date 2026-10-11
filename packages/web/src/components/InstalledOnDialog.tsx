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
  const [value, setValue] = useState(drive.installedOn ?? todayLocal());
  const [problem, setProblem] = useState<string | null>(null);

  const save = () => {
    const bad = installedOnError(value);
    setProblem(bad);
    if (bad) return;
    if (value === drive.installedOn) return onClose();
    update.mutate({ installedOn: value }, { onSuccess: onClose });
  };

  return (
    <Modal opened onClose={onClose} title="Installation date" centered>
      <Text size="sm">
        When did <strong className="mono">{drive.serial}</strong> go into its slot?
      </Text>
      <TextInput
        label="Installed on"
        description="The change is logged with today’s date."
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
        <Button onClick={save} loading={update.isPending}>
          Save
        </Button>
      </div>
    </Modal>
  );
}
