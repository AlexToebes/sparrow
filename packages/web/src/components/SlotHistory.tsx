import { Skeleton, Text } from '@mantine/core';
import { Link } from 'react-router';
import type { SlotHistoryEntry } from '@sparrow/shared';
import { useSlotHistory } from '../api/hooks';
import { formatBytes, formatDate } from '../lib/format';

/** A date, or "not recorded" with the day it was logged as a hint (like the life story). */
function When({ on, recordedAt }: { on: string | null; recordedAt: string | null }) {
  if (on !== null) return <span className="mono">{on}</span>;
  return (
    <>
      <span className="not-recorded">not recorded</span>
      {recordedAt ? (
        <span className="story-recorded"> (logged {formatDate(recordedAt)})</span>
      ) : null}
    </>
  );
}

function Outcome({ entry, gridName }: { entry: SlotHistoryEntry; gridName: string }) {
  const o = entry.outcome;
  if (o === null) return <>in this slot</>;
  switch (o.kind) {
    case 'moved':
      return (
        <>
          moved to {o.toGridName && o.toGridName !== gridName ? `${o.toGridName}, ` : ''}
          {o.toLabel}
        </>
      );
    case 'spares':
      return <>back to spares</>;
    case 'retired':
      return <>retired{o.reason ? ` (${o.reason})` : ''}</>;
    case 'rma':
      return <>sent for RMA</>;
  }
}

/** R74: every drive that sat in this slot, newest first, from the event log. Each serial opens that drive. */
export function SlotHistory({ slotId }: { slotId: string }) {
  const { data, isPending, isError } = useSlotHistory(slotId);
  if (isPending) return <Skeleton height={80} />;
  if (isError) return <Text c="red">Could not load the slot history.</Text>;
  if (data.entries.length === 0) {
    return <Text c="dimmed">No drive has been in {data.slot.label} yet.</Text>;
  }
  return (
    <section aria-label={`Slot history of ${data.slot.label}`}>
      <ol className="story">
        {data.entries.map((e, i) => (
          <li
            key={`${e.driveId}-${e.installedRecordedAt ?? i}`}
            className="story-item slot-history-item"
            data-current={e.outcome === null ? 'true' : undefined}
            data-unrecorded={e.installedOn === null ? 'true' : undefined}
          >
            <span className="story-dot" aria-hidden="true" />
            <div className="story-title">
              <Link className="mono" to={`/drives?drive=${encodeURIComponent(e.driveId)}`}>
                {e.serial}
              </Link>
              {e.capacityBytes ? (
                <span className="history-cap"> · {formatBytes(e.capacityBytes)}</span>
              ) : null}
            </div>
            <div className="story-detail">
              {e.outcome === null ? (
                <>
                  in this slot since <When on={e.installedOn} recordedAt={e.installedRecordedAt} />
                </>
              ) : (
                <>
                  installed <When on={e.installedOn} recordedAt={e.installedRecordedAt} /> → removed{' '}
                  <When on={e.removedOn} recordedAt={e.removedRecordedAt} />,{' '}
                  <Outcome entry={e} gridName={data.slot.gridName} />
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
