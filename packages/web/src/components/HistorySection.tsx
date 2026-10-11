import { useState } from 'react';
import { SegmentedControl } from '@mantine/core';
import type { Drive } from '@sparrow/shared';
import { LifeStory } from './LifeStory';
import { SlotHistory } from './SlotHistory';

export type HistoryTab = 'drive' | 'slot';

interface HistorySectionProps {
  /** The drive whose life story is shown; null for an empty slot. */
  drive: Drive | null;
  /** The slot to show the history of: the drive's current slot, or the empty slot itself. */
  slotId: string | null;
  initialTab?: HistoryTab;
}

/**
 * One "History" section (R74). An installed drive offers Drive | Slot; a spare or retired drive
 * has only its own history; an empty slot has only the slot history. The default is Drive.
 */
export function HistorySection({ drive, slotId, initialTab = 'drive' }: HistorySectionProps) {
  const both = drive !== null && slotId !== null;
  const [tab, setTab] = useState<HistoryTab>(initialTab);
  const shown: HistoryTab = both ? tab : drive ? 'drive' : 'slot';
  return (
    <div className="history">
      <div className="history-head">
        <h3 className="section-title">History</h3>
        {both ? (
          <SegmentedControl
            size="xs"
            aria-label="History for"
            value={tab}
            onChange={(v) => setTab(v as HistoryTab)}
            data={[
              { value: 'drive', label: 'Drive' },
              { value: 'slot', label: 'Slot' },
            ]}
          />
        ) : null}
      </div>
      {shown === 'drive' && drive ? <LifeStory driveId={drive.id} /> : null}
      {shown === 'slot' && slotId ? <SlotHistory slotId={slotId} /> : null}
    </div>
  );
}
