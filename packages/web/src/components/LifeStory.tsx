import { Skeleton, Text } from '@mantine/core';
import { Link } from 'react-router';
import { useDriveHistory } from '../api/hooks';
import { formatDuration } from '../lib/format';
import { buildStory, summarizeStory } from '../lib/lifeStory';
import { StateIcon } from './SlotTile';

/** The drive's history as a vertical timeline, oldest first (UI_DESIGN, from E). The "History" heading belongs to HistorySection. */
export function LifeStory({ driveId }: { driveId: string }) {
  const { data, isPending, isError } = useDriveHistory(driveId);
  if (isPending) return <Skeleton height={80} />;
  if (isError) return <Text c="red">Could not load the history.</Text>;
  if (data.length === 0) return <Text c="dimmed">No history yet.</Text>;
  const items = buildStory(data, driveId);
  const sum = summarizeStory(data, driveId);
  const parts = [
    sum.inService > 0 ? `${formatDuration(sum.inService)} in service` : null,
    sum.installUnrecorded ? 'Installation date not recorded' : null,
    sum.removalUnrecorded ? 'Removal date not recorded' : null,
    sum.retirementUnrecorded ? 'Retirement date not recorded' : null,
    sum.onShelf > 0 ? `${formatDuration(sum.onShelf)} on the shelf` : null,
  ].filter(Boolean);
  return (
    <section aria-label="Life story">
      {parts.length > 0 ? (
        <Text size="sm" c="dimmed" mb="sm">
          {parts.join(' · ')}
        </Text>
      ) : null}
      <ol className="story">
        {items.map((item) => (
          <li
            key={item.id}
            className="story-item"
            data-kind={item.kind}
            data-unrecorded={
              item.unrecorded || item.removalUnrecorded || item.retirementUnrecorded
                ? 'true'
                : undefined
            }
          >
            <span className="story-dot" aria-hidden="true" />
            <div className="story-head">
              <span>
                <span className="mono story-date">{item.date}</span>
                {item.unrecorded ? (
                  <span className="story-recorded"> · date recorded, install date unknown</span>
                ) : null}
                {item.removalUnrecorded ? (
                  <span className="story-recorded"> · date recorded, removal date unknown</span>
                ) : null}
                {item.retirementUnrecorded ? (
                  <span className="story-recorded"> · date recorded, retirement date unknown</span>
                ) : null}
                {item.recorded ? (
                  <span className="story-recorded"> · recorded {item.recorded}</span>
                ) : null}
              </span>
              {item.gap ? <span className="story-gap">{item.gap}</span> : null}
            </div>
            <div className="story-title">
              {item.health ? (
                <span className="story-health" data-health={item.health.to}>
                  <StateIcon state={item.health.to} size={14} /> {item.title}
                </span>
              ) : (
                item.title
              )}
              {item.slot ? (
                <>
                  {' '}
                  <Link
                    className="story-link"
                    to={`/?slot=${encodeURIComponent(item.slot.id)}&view=slot`}
                    aria-label={`Slot history of ${item.slot.label}`}
                  >
                    Slot history
                  </Link>
                </>
              ) : null}
            </div>
            {item.detail ? <div className="story-detail">{item.detail}</div> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
