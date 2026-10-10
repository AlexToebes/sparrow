import { useState } from 'react';
import { Button, Drawer, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import type { SlotView } from '../lib/health';
import { AssignDialog } from './AssignDialog';
import { DriveDetail } from './DriveDetail';
import { PlusIcon } from './icons';

interface SlotDetailProps {
  view: SlotView | null;
  gridName: string | null;
  onClose: () => void;
}

/** Slot detail: right side panel on desktop, bottom sheet on phone (D8). Actions live in DriveDetail. */
export function SlotDetail({ view, gridName, onClose }: SlotDetailProps) {
  const phone = useMediaQuery('(max-width: 48em)') ?? false;
  const drive = view?.drive ?? null;
  const [assigning, setAssigning] = useState(false);
  return (
    <Drawer
      opened={view !== null}
      onClose={onClose}
      position={phone ? 'bottom' : 'right'}
      size={phone ? '85%' : 460}
      title={gridName ?? 'Slot'}
      withCloseButton
      closeButtonProps={{ 'aria-label': 'Close' }}
    >
      {view ? (
        drive ? (
          <DriveDetail
            drive={drive}
            view={view}
            where={[gridName, view.label].filter(Boolean).join(', ')}
          />
        ) : (
          <div>
            <Text>{view.label} is empty.</Text>
            <Button mt="md" leftSection={<PlusIcon size={14} />} onClick={() => setAssigning(true)}>
              Assign a drive
            </Button>
            {assigning ? (
              <AssignDialog slotId={view.slotId} onClose={() => setAssigning(false)} />
            ) : null}
          </div>
        )
      ) : null}
    </Drawer>
  );
}
