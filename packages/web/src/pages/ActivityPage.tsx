import { Alert, Button, Skeleton } from '@mantine/core';
import { useActivityFeed } from '../api/hooks';
import { EmptyFeed, FeedList } from '../components/RecentChanges';
import { feedItems } from '../lib/recentChanges';

/** R75: every change in the log, newest first, a page at a time. Reached from the Layout card and Settings. */
export function ActivityPage() {
  const feed = useActivityFeed();
  const activities = feed.data?.pages.flat() ?? [];
  return (
    <>
      <h1 className="page-title">Recent changes</h1>
      <section className="card" aria-label="All changes">
        {feed.isPending ? <Skeleton height={120} /> : null}
        {feed.isError ? (
          <Alert color="red" title="Could not load the changes">
            {feed.error.message}{' '}
            <Button size="compact-sm" variant="light" onClick={() => feed.refetch()}>
              Retry
            </Button>
          </Alert>
        ) : null}
        {feed.isSuccess && activities.length === 0 ? <EmptyFeed /> : null}
        {activities.length > 0 ? (
          <FeedList items={feedItems(activities)} label="All changes list" />
        ) : null}
        {feed.hasNextPage ? (
          <Button
            variant="light"
            loading={feed.isFetchingNextPage}
            onClick={() => feed.fetchNextPage()}
          >
            Load more
          </Button>
        ) : null}
      </section>
    </>
  );
}
