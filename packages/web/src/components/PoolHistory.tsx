import { useState } from 'react';
import { Skeleton, Text } from '@mantine/core';
import { usePoolHistory } from '../api/hooks';
import { describePoolEvent } from '../lib/poolHistory';

/** A collapsed "History" list on a pool card: record changes and members joining, leaving, changing role. */
export function PoolHistory({ poolId, poolName }: { poolId: string; poolName: string }) {
  const [open, setOpen] = useState(false);
  const history = usePoolHistory(poolId, open);
  return (
    <details
      className="pool-history"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary aria-label={`${poolName} history`}>History</summary>
      {open && history.isPending ? <Skeleton height={48} mt="xs" /> : null}
      {open && history.isError ? (
        <Text c="red" size="sm" mt="xs">
          Could not load the history.
        </Text>
      ) : null}
      {open && history.isSuccess && history.data.length === 0 ? (
        <Text c="dimmed" size="sm" mt="xs">
          No history yet.
        </Text>
      ) : null}
      {open && history.isSuccess && history.data.length > 0 ? (
        <ol className="story pool-history-list" aria-label={`${poolName} history list`}>
          {history.data.map((e) => {
            const item = describePoolEvent(e);
            return (
              <li key={item.id} className="story-item" data-kind={e.type}>
                <span className="story-dot" aria-hidden="true" />
                <div className="story-head">
                  <span className="mono story-date">{item.date}</span>
                </div>
                <div className="story-title">{item.title}</div>
                {item.detail ? <div className="story-detail">{item.detail}</div> : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </details>
  );
}
