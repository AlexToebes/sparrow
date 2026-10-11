import { Skeleton, Text } from '@mantine/core';
import { useDriveEvents, usePools } from '../api/hooks';
import { formatDuration } from '../lib/format';
import { buildStory, summarizeStory } from '../lib/lifeStory';

/** The drive's history as a vertical timeline, oldest first (UI_DESIGN, from E). */
export function LifeStory({ driveId }: { driveId: string }) {
  const { data, isPending, isError } = useDriveEvents(driveId);
  const pools = usePools();
  if (isPending) return <Skeleton height={80} />;
  if (isError) return <Text c="red">Could not load the history.</Text>;
  if (data.length === 0) return <Text c="dimmed">No history yet.</Text>;
  const items = buildStory(data, (id) => pools.data?.find((p) => p.id === id)?.name ?? null);
  const sum = summarizeStory(data);
  const parts = [
    sum.inService > 0 ? `${formatDuration(sum.inService)} in service` : null,
    sum.installUnrecorded ? 'Installation date not recorded' : null,
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
          <li
            key={item.id}
            className="story-item"
            data-kind={item.kind}
            data-unrecorded={item.unrecorded ? 'true' : undefined}
          >
            <span className="story-dot" aria-hidden="true" />
            <div className="story-head">
              <span>
                <span className="mono story-date">{item.date}</span>
                {item.unrecorded ? (
                  <span className="story-recorded"> · date recorded, install date unknown</span>
                ) : null}
                {item.recorded ? (
                  <span className="story-recorded"> · recorded {item.recorded}</span>
                ) : null}
              </span>
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
