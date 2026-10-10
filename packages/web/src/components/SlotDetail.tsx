import { Badge, Drawer, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import type { PoolBadgeInfo } from '../api/hooks';
import { formatBytes, formatRelative } from '../lib/format';
import { HEALTH_WORD, type SlotView } from '../lib/health';
import { LifeStory } from './LifeStory';
import { StateIcon, poolColor } from './SlotTile';

interface SlotDetailProps {
  view: SlotView | null;
  gridName: string | null;
  pool?: PoolBadgeInfo;
  onClose: () => void;
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value ?? <span className="dim">not recorded</span>}</dd>
    </>
  );
}

/** Slot detail: right side panel on desktop, bottom sheet on phone (D8). Actions come in Step 12. */
export function SlotDetail({ view, gridName, pool, onClose }: SlotDetailProps) {
  const phone = useMediaQuery('(max-width: 48em)') ?? false;
  const drive = view?.drive ?? null;
  const status = view?.status ?? null;
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
          <div className="detail">
            <h2 className="detail-serial mono">{drive.serial}</h2>
            <Text c="dimmed" size="sm">
              {[drive.model, drive.driveType, formatBytes(drive.capacityBytes)]
                .filter(Boolean)
                .join(' · ')}
            </Text>
            <div className="detail-badges">
              <Badge variant="light" color="indigo">
                {view.label}
              </Badge>
              <Badge variant="light" color={view.state === 'ok' ? 'green' : stateColor(view.state)}>
                <span className="badge-icon">
                  <StateIcon state={view.state} size={12} />
                </span>{' '}
                {view.word}
              </Badge>
              {pool ? (
                <Badge variant="light" color={poolColor(pool.colorIndex)}>
                  {pool.poolName} · {pool.role === 'hot-spare' ? 'hot spare' : 'data'}
                </Badge>
              ) : null}
            </div>
            <dl className="facts">
              <Row
                label="Where"
                value={[gridName, view.label, pool?.poolName].filter(Boolean).join(' · ')}
              />
              <Row label="Condition" value={drive.condition} />
              <Row
                label="Bought"
                value={[drive.purchaseDate, drive.vendor].filter(Boolean).join(' · ') || null}
              />
              <Row label="Warranty" value={drive.warrantyExpiry} />
              <Row label="Last tested" value={drive.lastTestDate} />
              <Row label="Notes" value={drive.notes} />
            </dl>
            <div className="health-box" data-state={view.state}>
              <strong>
                <StateIcon state={view.state} size={14} /> {view.word}
              </strong>
              <div>
                {status
                  ? `Last known: ${HEALTH_WORD[view.health]}. Reported ${formatRelative(status.lastReportedAt)}${
                      status.temperatureC !== null ? `, ${status.temperatureC} °C` : ''
                    }.`
                  : 'No health data from a provider.'}
                {view.note && view.state === 'missing' ? ` ${view.note}.` : ''}
              </div>
              {status?.detailUrl ? (
                <a href={status.detailUrl} target="_blank" rel="noopener noreferrer">
                  Open in provider
                </a>
              ) : null}
            </div>
            <LifeStory driveId={drive.id} />
          </div>
        ) : (
          <Text>
            {view.label} is empty. Assigning a drive arrives in a later step; the Drives page will
            list spares.
          </Text>
        )
      ) : null}
    </Drawer>
  );
}

function stateColor(state: SlotView['state']): string {
  switch (state) {
    case 'failed':
      return 'red';
    case 'warning':
    case 'missing':
      return 'yellow';
    case 'ok':
      return 'green';
    default:
      return 'gray';
  }
}
