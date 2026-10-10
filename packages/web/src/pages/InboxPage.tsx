import { useState } from 'react';
import { Alert, Badge, Button, Skeleton, Text } from '@mantine/core';
import { useDrives, useInbox } from '../api/hooks';
import { ImportRetiredPanel } from '../components/ImportRetiredPanel';
import { InboxEntryCard } from '../components/InboxEntryCard';
import { formatBytes, formatRelative } from '../lib/format';

export function InboxPage() {
  const inbox = useInbox();
  const drives = useDrives();
  const [importing, setImporting] = useState(false);

  if (inbox.isPending) return <Skeleton height={160} />;
  if (inbox.isError) {
    return (
      <Alert color="red" title="Could not load the inbox">
        {inbox.error.message}
      </Alert>
    );
  }
  const { entries, unidentified, retiredCandidates } = inbox.data;
  // R24: first run, everything the provider reports is new and no drive records exist yet.
  const firstRun = entries.length > 0 && drives.data !== undefined && drives.data.length === 0;

  return (
    <>
      <h1 className="page-title">Inbox</h1>
      <Text c="dimmed" mb="md">
        Drives the NAS reports that Sparrow has not placed yet: new drives, and spares you already
        track that are now inside the NAS. Resolve each one by linking it to a spare or creating a
        record, and choose its slot.
      </Text>

      {firstRun ? (
        <Alert color="indigo" variant="light" mb="md" title="Welcome to Sparrow">
          Your provider found {entries.length} {entries.length === 1 ? 'drive' : 'drives'} in the
          NAS. For each one, create a record and pick the bay it sits in. Then you can import
          retired drives, if any are listed below, and set up pools in Settings.
        </Alert>
      ) : null}

      {entries.length === 0 ? (
        <section className="card">
          <Text>Nothing to resolve. Every drive the provider reports is already placed.</Text>
        </section>
      ) : (
        entries.map((e) => <InboxEntryCard key={e.observationKey} entry={e} />)
      )}

      {unidentified.length > 0 ? (
        <section className="card" aria-label="Unidentified">
          <div className="card-head">
            <h2 className="card-title">Unidentified</h2>
            <Badge variant="light" color="gray">
              {unidentified.length}
            </Badge>
          </div>
          <Text size="sm" c="dimmed" mb="sm">
            The provider reports these drives without a serial number, so Sparrow cannot match or
            record them. They are listed for information only and cannot be linked.
          </Text>
          <ul className="plain-list">
            {unidentified.map((o, i) => (
              <li key={i}>
                {[o.model, o.driveType, formatBytes(o.capacityBytes)].filter(Boolean).join(' · ') ||
                  'No details reported'}
                <span className="dim"> · last reported {formatRelative(o.lastReportedAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {retiredCandidates.length > 0 ? (
        <section className="card" aria-label="Retired drives">
          <div className="card-head">
            <h2 className="card-title">Import retired drives</h2>
            <Button variant="default" size="compact-md" onClick={() => setImporting((v) => !v)}>
              {importing ? 'Hide' : `Review ${retiredCandidates.length}`}
            </Button>
          </div>
          {importing ? (
            <ImportRetiredPanel candidates={retiredCandidates} />
          ) : (
            <Text size="sm" c="dimmed">
              {retiredCandidates.length} decommissioned{' '}
              {retiredCandidates.length === 1 ? 'drive is' : 'drives are'} still reported. You can
              record them as retired, or skip this.
            </Text>
          )}
        </section>
      ) : null}
    </>
  );
}
