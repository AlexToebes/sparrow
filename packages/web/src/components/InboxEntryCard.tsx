import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Modal, Text } from '@mantine/core';
import type { InboxEntry } from '@sparrow/shared';
import { useCreateFromObservation, useLinkObservation } from '../api/inboxMutations';
import { ApiError } from '../api/client';
import { useDrives, useInbox, useLayout, useSlotStatus } from '../api/hooks';
import { formatBytes, formatRelative } from '../lib/format';
import { HEALTH_WORD, slotLabel } from '../lib/health';
import { isObservationStale } from '../lib/observationAge';
import { AssignDialog } from './AssignDialog';
import { stateColor } from './DriveDetail';
import { StateIcon } from './SlotTile';
import { SparePicker } from './SparePicker';
import { driveLabel } from './RetireFields';

const LINKABLE = ['spare', 'installed'] as const;

type Step =
  | null
  | { kind: 'pick' }
  | { kind: 'link'; driveId: string }
  | { kind: 'confirm'; driveId: string }
  | { kind: 'create' };

/** One discovered drive (R22): what the provider reports, a suggested spare if any (R25), and the actions. */
export function InboxEntryCard({ entry }: { entry: InboxEntry }) {
  const { observation: o, suggestion } = entry;
  const serial = o.serial ?? '';
  const [step, setStep] = useState<Step>(null);
  const allDrives = useDrives();
  const inbox = useInbox();
  const layout = useLayout();
  const staleAfterHours = useSlotStatus().data?.staleAfterHours;
  const stale = isObservationStale(o.lastReportedAt, staleAfterHours);
  const create = useCreateFromObservation(entry.observationKey);
  const [pick, setPick] = useState<string | null>(suggestion?.id ?? null);
  const close = () => {
    setStep(null);
    setLinkError(null);
  };
  // R22: any drive record that is not retired and does not already match an observation (R2). The
  // server reports the matched ones; the spare this very observation matches (R25) stays offered.
  const linkable = useMemo(() => {
    const matched = new Set(inbox.data?.matchedDriveIds ?? []);
    return (allDrives.data ?? []).filter(
      (d) =>
        (d.status === 'spare' || d.status === 'installed') &&
        (!matched.has(d.id) || d.id === suggestion?.id),
    );
  }, [allDrives.data, inbox.data, suggestion?.id]);
  const bayLabels = useMemo(
    () =>
      new Map(
        (layout.data?.enclosures ?? []).flatMap((e) =>
          e.grids.flatMap((g) =>
            g.slots.map((sl) => [sl.id, `${g.name} · ${slotLabel(sl)}`] as const),
          ),
        ),
      ),
    [layout.data],
  );
  const chosen = (id: string) => allDrives.data?.find((d) => d.id === id);
  const link = useLinkObservation(entry.observationKey);
  const [linkError, setLinkError] = useState<string | null>(null);
  const noSpares = allDrives.isSuccess && linkable.length === 0;
  const facts = [o.model, o.driveType, formatBytes(o.capacityBytes)].filter(Boolean).join(' · ');

  return (
    <article className="card inbox-card" aria-label={`Discovered drive ${serial}`}>
      <div className="card-head">
        <h2 className="card-title mono">{serial}</h2>
        {stale ? (
          <Badge variant="outline" color="gray" className="stale-badge">
            <span className="badge-icon">
              <StateIcon state="stale" size={12} />
            </span>{' '}
            Stale · last known {HEALTH_WORD[o.health]}
          </Badge>
        ) : (
          <Badge variant="light" color={stateColor(o.health)}>
            <span className="badge-icon">
              <StateIcon state={o.health} size={12} />
            </span>{' '}
            {HEALTH_WORD[o.health]}
          </Badge>
        )}
      </div>
      <Text c="dimmed" size="sm">
        {facts || 'No model or capacity reported'}
      </Text>
      <Text c="dimmed" size="sm">
        Last reported {formatRelative(o.lastReportedAt)}
      </Text>

      {suggestion ? (
        <Alert color="indigo" variant="light" mt="sm" className="suggestion">
          Looks like spare <strong className="mono">{suggestion.serial}</strong> (
          {driveLabel(suggestion).split(' · ').slice(1).join(' · ') || 'no details'}) — link it?
          Nothing changes until you confirm.
          <div className="detail-actions">
            <Button
              size="compact-md"
              onClick={() => setStep({ kind: 'link', driveId: suggestion.id })}
            >
              Link to {suggestion.serial}
            </Button>
          </div>
        </Alert>
      ) : null}

      <div className="detail-actions">
        <Button
          size="compact-md"
          variant={suggestion || noSpares ? 'default' : 'filled'}
          disabled={noSpares}
          onClick={() => setStep({ kind: 'pick' })}
        >
          Link to a drive
        </Button>
        <Button
          size="compact-md"
          variant={noSpares && !suggestion ? 'filled' : 'default'}
          onClick={() => setStep({ kind: 'create' })}
        >
          Create new record
        </Button>
      </div>
      {noSpares ? (
        <Text size="sm" c="dimmed" mt="xs">
          There is no drive record to link this to, so create a new record for it.
        </Text>
      ) : null}

      {step?.kind === 'pick' ? (
        <Modal opened onClose={close} title={`Link ${serial} to a drive`} centered>
          <Text size="sm" c="dimmed" mb="xs">
            Pick the record this drive is, for example one added with the serial on its sticker.
            Drives that already show live data and retired drives are not listed. The record keeps
            its history and gains the reported details.
          </Text>
          <SparePicker
            spares={linkable}
            value={pick}
            onChange={setPick}
            loading={allDrives.isPending}
            label="Drive"
            statuses={LINKABLE}
            bayLabels={bayLabels}
            noun="drives"
          />
          <div className="dialog-actions">
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Button
              disabled={!pick}
              onClick={() =>
                pick &&
                setStep({
                  kind: chosen(pick)?.status === 'installed' ? 'confirm' : 'link',
                  driveId: pick,
                })
              }
            >
              Next
            </Button>
          </div>
        </Modal>
      ) : null}

      {step?.kind === 'link' ? (
        <AssignDialog
          onClose={close}
          placement={{
            incomingSerial: chosen(step.driveId)?.serial ?? serial,
            pending: link.isPending,
            summary: (
              <>
                Link <strong className="mono">{serial}</strong> to spare{' '}
                <strong className="mono">{chosen(step.driveId)?.serial ?? '…'}</strong> and put it
                in
              </>
            ),
            run: (input, cb) => link.mutate({ driveId: step.driveId, ...input }, cb),
          }}
          driveId={step.driveId}
        />
      ) : null}
      {step?.kind === 'confirm' ? (
        <Modal opened onClose={close} title="Link to this drive" centered>
          <Text size="sm">
            Link <strong className="mono">{serial}</strong> to{' '}
            <strong className="mono">{chosen(step.driveId)?.serial ?? '…'}</strong> in{' '}
            <strong>{bayLabels.get(chosen(step.driveId)?.slotId ?? '') ?? 'its bay'}</strong>. It
            stays in its bay.
          </Text>
          {linkError ? (
            <Alert color="red" mt="sm">
              {linkError}
            </Alert>
          ) : null}
          <div className="dialog-actions">
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Button
              loading={link.isPending}
              onClick={() => {
                setLinkError(null);
                link.mutate(
                  { driveId: step.driveId },
                  {
                    onSuccess: close,
                    onError: (e) =>
                      setLinkError(e instanceof ApiError ? e.message : 'Could not link the drive.'),
                  },
                );
              }}
            >
              Link
            </Button>
          </div>
        </Modal>
      ) : null}
      {step?.kind === 'create' ? (
        <AssignDialog
          onClose={close}
          placement={{
            incomingSerial: serial,
            pending: create.isPending,
            summary: (
              <>
                Create a record for <strong className="mono">{serial}</strong> and put it in
              </>
            ),
            run: (input, cb) => create.mutate(input, cb),
          }}
        />
      ) : null}
    </article>
  );
}
