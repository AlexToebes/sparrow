import { Alert, Skeleton, Text } from '@mantine/core';
import { Link } from 'react-router';
import { useRecentActivities } from '../api/hooks';
import { feedItems, type FeedIcon, type FeedItem } from '../lib/recentChanges';
import { DriveIcon, GridIcon, PoolIcon, SettingsIcon, UpdateIcon } from './icons';
import { StateIcon } from './SlotTile';

export const RECENT_CARD_COUNT = 5;

function KindIcon({ item }: { item: FeedItem }) {
  if (item.health) return <StateIcon state={item.health} size={16} />;
  const icons: Record<FeedIcon, typeof DriveIcon> = {
    drive: DriveIcon,
    bay: GridIcon,
    pool: PoolIcon,
    layout: SettingsIcon,
    health: UpdateIcon,
    suggestion: UpdateIcon,
  };
  const Icon = icons[item.icon];
  return <Icon size={16} />;
}

/** The feed as a list: icon, one sentence (serials and bays link), the effective date. */
export function FeedList({ items, label }: { items: FeedItem[]; label: string }) {
  return (
    <ol className="feed" aria-label={label}>
      {items.map((item) => (
        <li key={item.id} className="feed-item" data-kind={item.kind} data-icon={item.icon}>
          <span className="feed-icon" data-health={item.health ?? undefined}>
            <KindIcon item={item} />
          </span>
          <div className="feed-body">
            <div className="feed-text">
              {item.parts.map((p, n) =>
                typeof p === 'string' ? (
                  <span key={n}>{p}</span>
                ) : (
                  <Link key={n} className="story-link" to={p.to}>
                    {p.text}
                  </Link>
                ),
              )}
            </div>
            <div className="feed-date">
              <span className="mono">{item.date}</span>
              {item.recorded ? (
                <span className="story-recorded"> · recorded {item.recorded}</span>
              ) : null}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function EmptyFeed() {
  return (
    <Text c="dimmed" size="sm">
      Nothing has happened yet.
    </Text>
  );
}

/** R75: the latest few activities at the bottom of the Layout page, with a link to the full list. */
export function RecentChangesCard() {
  const recent = useRecentActivities(RECENT_CARD_COUNT);
  return (
    <section className="card" aria-label="Recent changes">
      <div className="card-head">
        <h2 className="card-title">Recent changes</h2>
        <Link to="/activity" className="story-link">
          Show all
        </Link>
      </div>
      {recent.isPending ? <Skeleton height={80} /> : null}
      {recent.isError ? (
        <Alert color="red" title="Could not load the recent changes">
          {recent.error.message}
        </Alert>
      ) : null}
      {recent.isSuccess && recent.data.length === 0 ? <EmptyFeed /> : null}
      {recent.isSuccess && recent.data.length > 0 ? (
        <FeedList items={feedItems(recent.data)} label="Recent changes list" />
      ) : null}
    </section>
  );
}
