import { useState } from 'react';
import { Button, Drawer, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import type { SlotView } from '../lib/health';
import { AssignDialog } from './AssignDialog';
import { DriveDetail } from './DriveDetail';
import { HistorySection, type HistoryTab } from './HistorySection';
import { PlusIcon } from './icons';

interface SlotDetailProps {
  view: SlotView | null;
  gridName: string | null;
  /** Which History tab opens first for an occupied bay. */
  historyTab?: HistoryTab;
  onClose: () => void;
}

/** Slot detail: right side panel on desktop, bottom sheet on phone (D8). Actions live in DriveDetail. */
export function SlotDetail({ view, gridName, historyTab, onClose }: SlotDetailProps) {
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
            key={`${view.slotId}-${historyTab ?? 'drive'}`}
            drive={drive}
            view={view}
            where={[gridName, view.label].filter(Boolean).join(', ')}
            {...(historyTab ? { historyTab } : {})}
          />
        ) : (
          <div className="detail">
            <Text>{view.label} is empty.</Text>
            <Button mt="md" leftSection={<PlusIcon size={14} />} onClick={() => setAssigning(true)}>
              Assign a drive
            </Button>
            {assigning ? (
              <AssignDialog slotId={view.slotId} onClose={() => setAssigning(false)} />
            ) : null}
            <HistorySection drive={null} slotId={view.slotId} />
          </div>
        )
      ) : null}
    </Drawer>
  );
}
