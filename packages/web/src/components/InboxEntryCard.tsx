import { useState } from 'react';
import { Alert, Badge, Button, Modal, Select, Text } from '@mantine/core';
import type { InboxEntry } from '@sparrow/shared';
import { useCreateFromObservation, useLinkObservation } from '../api/inboxMutations';
import { useDrives } from '../api/hooks';
import { formatBytes, formatRelative } from '../lib/format';
import { HEALTH_WORD } from '../lib/health';
import { AssignDialog } from './AssignDialog';
import { stateColor } from './DriveDetail';
import { StateIcon } from './SlotTile';
import { driveLabel } from './RetireFields';

type Step = null | { kind: 'pick' } | { kind: 'link'; driveId: string } | { kind: 'create' };

/** One discovered drive (R22): what the provider reports, a suggested spare if any (R25), and the actions. */
export function InboxEntryCard({ entry }: { entry: InboxEntry }) {
  const { observation: o, suggestion } = entry;
  const serial = o.serial ?? '';
  const [step, setStep] = useState<Step>(null);
  const spares = useDrives('spare');
  const link = useLinkObservation(entry.observationKey);
  const create = useCreateFromObservation(entry.observationKey);
  const [pick, setPick] = useState<string | null>(suggestion?.id ?? null);
  const close = () => setStep(null);
  const facts = [o.model, o.driveType, formatBytes(o.capacityBytes)].filter(Boolean).join(' · ');

  return (
    <article className="card inbox-card" aria-label={`Inbox entry ${serial}`}>
      <div className="card-head">
        <h2 className="card-title mono">{serial}</h2>
        <Badge variant="light" color={stateColor(o.health)}>
          <span className="badge-icon">
            <StateIcon state={o.health} size={12} />
          </span>{' '}
          {HEALTH_WORD[o.health]}
        </Badge>
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
          variant={suggestion ? 'default' : 'filled'}
          onClick={() => setStep({ kind: 'pick' })}
        >
          Link to a spare
        </Button>
        <Button size="compact-md" variant="default" onClick={() => setStep({ kind: 'create' })}>
          Create new record
        </Button>
      </div>

      {step?.kind === 'pick' ? (
        <Modal opened onClose={close} title={`Link ${serial} to a spare`} centered>
          <Select
            label="Spare"
            description="Spares only. The drive record keeps its history and gains the reported details."
            placeholder="Choose a spare"
            searchable
            data={(spares.data ?? []).map((d) => ({ value: d.id, label: driveLabel(d) }))}
            value={pick}
            onChange={setPick}
            nothingFoundMessage="No spares"
          />
          <div className="dialog-actions">
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Button
              disabled={!pick}
              onClick={() => pick && setStep({ kind: 'link', driveId: pick })}
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
            incomingSerial: spares.data?.find((d) => d.id === step.driveId)?.serial ?? serial,
            pending: link.isPending,
            summary: (
              <>
                Link <strong className="mono">{serial}</strong> to spare{' '}
                <strong className="mono">
                  {spares.data?.find((d) => d.id === step.driveId)?.serial ?? '…'}
                </strong>{' '}
                and put it in
              </>
            ),
            run: (input, cb) => link.mutate({ driveId: step.driveId, ...input }, cb),
          }}
          driveId={step.driveId}
        />
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
