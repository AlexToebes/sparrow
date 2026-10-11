import { useEffect, useRef, type ReactNode } from 'react';
import { Modal, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';

export interface StepDef<K extends string = string> {
  key: K;
  title: string;
}

/**
 * Shared shell for multi-step dialogs (R70): one decision per step. Shows "Step N of M · title"
 * (N and M follow the steps actually in play), one step's content at a time and a footer that stays
 * visible while the content scrolls. On a phone the dialog is fullscreen so a step such as the slot
 * picker gets the whole screen. Focus moves to the step heading whenever the step changes.
 * The caller owns the navigation and passes the buttons as `footer`.
 */
export function StepFlow<K extends string>({
  title,
  steps,
  current,
  onClose,
  footer,
  children,
}: {
  title: string;
  steps: StepDef<K>[];
  current: K;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
}) {
  const phone = useMediaQuery('(max-width: 48em)') ?? false;
  const heading = useRef<HTMLParagraphElement>(null);
  const first = useRef(true);
  useEffect(() => {
    // Not on open: Modal places the initial focus itself.
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [current]);

  const index = Math.max(
    0,
    steps.findIndex((s) => s.key === current),
  );
  return (
    <Modal
      opened
      onClose={onClose}
      title={title}
      centered={!phone}
      fullScreen={phone}
      size="lg"
      classNames={{ content: 'step-modal-content', body: 'step-modal-body' }}
    >
      <Text
        ref={heading}
        tabIndex={-1}
        size="sm"
        fw={600}
        mb="xs"
        className="step-heading"
        aria-live="polite"
      >
        Step {index + 1} of {steps.length} · {steps[index]?.title}
      </Text>
      <div className="step-content">{children}</div>
      <div className="step-footer">{footer}</div>
    </Modal>
  );
}
