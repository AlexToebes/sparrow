import { useState } from 'react';
import { Badge, Button, Text } from '@mantine/core';
import type { Drive } from '@sparrow/shared';
import { useDriveAction } from '../api/driveMutations';
import { useDrivePools, useDrives } from '../api/hooks';
import { formatBytes, formatRelative } from '../lib/format';
import { HEALTH_WORD, type SlotView } from '../lib/health';
import { AssignDialog } from './AssignDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { DriveFormDialog } from './DriveFormDialog';
import { InstalledOnDialog } from './InstalledOnDialog';
import { LifeStory } from './LifeStory';
import { MembershipSection } from './MembershipSection';
import { MissingDrivePanel } from './MissingDrivePanel';
import { MoveDialog } from './MoveDialog';
import { RetireDialog } from './RetireDialog';
import { StateIcon, poolColor } from './SlotTile';
import { SuggestedUpdates } from './SuggestedUpdates';

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value ?? <span className="dim">not recorded</span>}</dd>
    </>
  );
}

export function stateColor(state: SlotView['state']): string {
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

const STATUS_WORD = { spare: 'Spare', installed: 'Installed', retired: 'Retired' } as const;

interface DriveDetailProps {
  drive: Drive;
  /** Present when shown from a slot: adds the live health block. */
  view?: SlotView | null;
  /** "Front bays, Bay 3" for an installed drive. */
  where?: string | null;
}

type Dialog =
  'assign' | 'move' | 'move-retire' | 'edit' | 'installed-on' | 'retire' | 'reinstate' | null;

/** One drive: facts, health (when in a slot), actions and life story. Used by the slot panel and the Drives page. */
export function DriveDetail({ drive, view = null, where = null }: DriveDetailProps) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const pool = useDrivePools().get(drive.id);
  const drives = useDrives();
  const reinstate = useDriveAction(drive.id, 'reinstate');
  const status = view?.status ?? null;
  const replacedBy = drive.replacedByDriveId
    ? (drives.data?.find((d) => d.id === drive.replacedByDriveId) ?? null)
    : null;
  const close = () => setDialog(null);

  return (
    <div className="detail">
      <h2 className="detail-serial mono">{drive.serial}</h2>
      <Text c="dimmed" size="sm">
        {[drive.model, drive.driveType, formatBytes(drive.capacityBytes)]
          .filter(Boolean)
          .join(' · ')}
      </Text>
      <div className="detail-badges">
        <Badge variant="light" color={drive.status === 'retired' ? 'gray' : 'indigo'}>
          {STATUS_WORD[drive.status]}
        </Badge>
        {view ? (
          <>
            <Badge variant="light" color="indigo">
              {view.label}
            </Badge>
            <Badge variant="light" color={stateColor(view.state)}>
              <span className="badge-icon">
                <StateIcon state={view.state} size={12} />
              </span>{' '}
              {view.word}
            </Badge>
          </>
        ) : null}
        {pool ? (
          <Badge variant="light" color={poolColor(pool.colorIndex)}>
            {pool.poolName} · {pool.role === 'hot-spare' ? 'hot spare' : 'data'}
          </Badge>
        ) : null}
      </div>

      <div className="detail-actions">
        {drive.status === 'spare' ? (
          <Button size="compact-md" onClick={() => setDialog('assign')}>
            Assign to slot
          </Button>
        ) : null}
        {drive.status === 'installed' && drive.slotId ? (
          <Button size="compact-md" onClick={() => setDialog('move')}>
            Move
          </Button>
        ) : null}
        {drive.status === 'retired' ? (
          <Button size="compact-md" onClick={() => setDialog('reinstate')}>
            Reinstate
          </Button>
        ) : (
          <Button
            size="compact-md"
            variant="light"
            color="red"
            onClick={() =>
              setDialog(drive.status === 'installed' && drive.slotId ? 'move-retire' : 'retire')
            }
          >
            Retire
          </Button>
        )}
        <Button size="compact-md" variant="default" onClick={() => setDialog('edit')}>
          Edit
        </Button>
      </div>

      {view?.state === 'missing' && status?.flag && drive.status === 'installed' ? (
        <MissingDrivePanel drive={drive} reason={status.flag.reason} where={where} />
      ) : null}
      <dl className="facts">
        <Row
          label="Where"
          value={
            drive.status === 'installed'
              ? [where, pool?.poolName].filter(Boolean).join(' · ') || null
              : drive.status === 'spare'
                ? drive.storageLocation
                  ? `On the shelf: ${drive.storageLocation}`
                  : 'On the shelf'
                : 'Retired'
          }
        />
        {drive.status === 'installed' ? (
          <>
            <dt>{drive.installedOn ? 'Installed on' : 'Installed'}</dt>
            <dd>
              <span className="inline-edit">
                {drive.installedOn ? (
                  <span className="mono">{drive.installedOn}</span>
                ) : (
                  <span className="not-recorded">not recorded</span>
                )}
                <Button
                  size="compact-xs"
                  variant="subtle"
                  aria-label={
                    drive.installedOn ? 'Edit installation date' : 'Set installation date'
                  }
                  onClick={() => setDialog('installed-on')}
                >
                  {drive.installedOn ? 'Edit' : 'Set date'}
                </Button>
              </span>
            </dd>
          </>
        ) : null}
        {drive.status === 'retired' ? (
          <>
            <Row
              label="Retired"
              value={[
                drive.retirementReason,
                drive.retirementDate ?? 'retirement date not recorded',
              ]
                .filter(Boolean)
                .join(' · ')}
            />
            <Row
              label="Replaced by"
              value={
                drive.replacedByDriveId
                  ? `${replacedBy?.serial ?? drive.replacedByDriveId}${
                      replacedBy?.capacityBytes ? ` (${formatBytes(replacedBy.capacityBytes)})` : ''
                    }`
                  : null
              }
            />
            <Row label="Retirement note" value={drive.retirementNote} />
          </>
        ) : null}
        <Row label="Condition" value={drive.condition} />
        <Row label="Form factor" value={drive.formFactor} />
        <Row
          label="Bought"
          value={[drive.purchaseDate, drive.vendor].filter(Boolean).join(' · ') || null}
        />
        <Row label="Warranty" value={drive.warrantyExpiry} />
        <Row label="Last tested" value={drive.lastTestDate} />
        <Row label="Notes" value={drive.notes} />
      </dl>
      <SuggestedUpdates drive={drive} />

      {view ? (
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
      ) : null}
      {drive.status === 'installed' ? <MembershipSection drive={drive} /> : null}
      <LifeStory driveId={drive.id} />

      {dialog === 'assign' ? <AssignDialog driveId={drive.id} onClose={close} /> : null}
      {dialog === 'edit' ? <DriveFormDialog drive={drive} onClose={close} /> : null}
      {dialog === 'installed-on' ? <InstalledOnDialog drive={drive} onClose={close} /> : null}
      {dialog === 'retire' ? <RetireDialog drive={drive} opened onClose={close} /> : null}
      {dialog === 'move' || dialog === 'move-retire' ? (
        <MoveDialog
          drive={drive}
          where={where}
          initialDestination={dialog === 'move-retire' ? 'retire' : null}
          onClose={close}
        />
      ) : null}
      {dialog === 'reinstate' ? (
        <ConfirmDialog
          title="Reinstate drive"
          confirmLabel="Reinstate as spare"
          mutation={reinstate}
          body={{}}
          onClose={close}
        >
          <Text>
            Bring <strong className="mono">{drive.serial}</strong> back as a spare? The retirement
            stays in its history.
          </Text>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
