import { Skeleton, Text } from '@mantine/core';
import { useDriveEvents } from '../api/hooks';
import { formatDate, formatDuration } from '../lib/format';
import { buildStory, summarizeStory } from '../lib/lifeStory';

/** The drive's history as a vertical timeline, oldest first (UI_DESIGN, from E). */
export function LifeStory({ driveId }: { driveId: string }) {
  const { data, isPending, isError } = useDriveEvents(driveId);
  if (isPending) return <Skeleton height={80} />;
  if (isError) return <Text c="red">Could not load the history.</Text>;
  if (data.length === 0) return <Text c="dimmed">No history yet.</Text>;
  const items = buildStory(data);
  const sum = summarizeStory(data);
  const parts = [
    sum.inService > 0 ? `${formatDuration(sum.inService)} in service` : null,
    sum.onShelf > 0 ? `${formatDuration(sum.onShelf)} on the shelf` : null,
  ].filter(Boolean);
  return (
    <section aria-label="Life story">
      <h3 className="section-title">Life story</h3>
      {parts.length > 0 ? (
        <Text size="sm" c="dimmed" mb="sm">
          {parts.join(' · ')}
        </Text>
      ) : null}
      <ol className="story">
        {items.map((item) => (
          <li key={item.id} className="story-item" data-kind={item.kind}>
            <span className="story-dot" aria-hidden="true" />
            <div className="story-head">
              <span className="mono story-date">{formatDate(item.at)}</span>
              {item.gap ? <span className="story-gap">{item.gap}</span> : null}
            </div>
            <div className="story-title">{item.title}</div>
            {item.detail ? <div className="story-detail">{item.detail}</div> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
