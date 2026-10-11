import { useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Modal } from '@mantine/core';
import type { UseMutationResult } from '@tanstack/react-query';

interface ConfirmDialogProps {
  title: string;
  confirmLabel: string;
  color?: string;
  children: ReactNode;
  /** Runs the action; the dialog closes when it resolves and shows the error when it rejects. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mutation: UseMutationResult<unknown, Error, any>;
  body: unknown;
  /** Blocks the confirm button while the dialog's own fields are invalid. */
  confirmDisabled?: boolean;
  onClose: () => void;
}

/** Confirm step for a destructive or state-changing action. Mount only while open. */
export function ConfirmDialog({
  title,
  confirmLabel,
  color = 'indigo',
  children,
  mutation,
  body,
  confirmDisabled = false,
  onClose,
}: ConfirmDialogProps) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal opened onClose={onClose} title={title} centered>
      {children}
      {error ? (
        <Alert color="red" mt="sm">
          {error}
        </Alert>
      ) : null}
      <div className="dialog-actions">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button
          color={color}
          loading={mutation.isPending}
          disabled={confirmDisabled}
          onClick={() =>
            mutation.mutate(body, {
              onSuccess: onClose,
              onError: (e) => setError(e.message),
            })
          }
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
