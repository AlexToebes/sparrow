import { useState } from 'react';
import { Button, Text, Textarea, TextInput } from '@mantine/core';
import type { Drive, SlotFlag } from '@sparrow/shared';
import { useDriveAction } from '../api/driveMutations';
import { ConfirmDialog } from './ConfirmDialog';
import { RetireDialog } from './RetireDialog';
import { todayLocal } from './RetireFields';

const REASON_TEXT: Record<SlotFlag['reason'], string> = {
  decommissioned: 'The provider reports this drive as decommissioned.',
  'not-reported': 'The provider no longer reports this drive.',
  stale: 'The provider has not reported this drive recently.',
};

type Outcome = 'spares' | 'retire' | 'rma' | null;

/**
 * R27: a flagged slot still holds its drive. Sparrow never changes it on its own; the user picks one of
 * three outcomes, each confirmed. The layout and status refetch after success.
 */
export function MissingDrivePanel({
  drive,
  reason,
  where,
}: {
  drive: Drive;
  reason: SlotFlag['reason'];
  where: string | null;
}) {
  const [outcome, setOutcome] = useState<Outcome>(null);
  const remove = useDriveAction(drive.id, 'remove');
  const rma = useDriveAction(drive.id, 'rma');
  const [rmaDate, setRmaDate] = useState(todayLocal);
  const [rmaNote, setRmaNote] = useState('');
  const close = () => setOutcome(null);

  return (
    <section className="missing-box" aria-label="Drive missing">
      <h3>Drive missing</h3>
      <Text size="sm">
        {REASON_TEXT[reason]} Sparrow has not changed anything: the drive is still recorded in{' '}
        {where ?? 'this slot'}. What happened to it?
      </Text>
      <div className="detail-actions">
        <Button size="compact-md" variant="default" onClick={() => setOutcome('spares')}>
          Back to spares
        </Button>
        <Button size="compact-md" variant="light" color="red" onClick={() => setOutcome('retire')}>
          Retire
        </Button>
        <Button size="compact-md" variant="light" color="orange" onClick={() => setOutcome('rma')}>
          Send for RMA
        </Button>
      </div>

      {outcome === 'spares' ? (
        <ConfirmDialog
          title="Back to spares"
          confirmLabel="Move to spares"
          mutation={remove}
          body={{}}
          onClose={close}
        >
          <Text>
            Move <strong className="mono">{drive.serial}</strong> out of {where ?? 'its slot'} back
            to the spares shelf? Check that it is really out of the NAS. Its pool membership ends;
            its history is kept.
          </Text>
        </ConfirmDialog>
      ) : null}
      {outcome === 'retire' ? <RetireDialog drive={drive} opened onClose={close} /> : null}
      {outcome === 'rma' ? (
        <ConfirmDialog
          title="Send for RMA"
          confirmLabel="Send for RMA"
          color="orange"
          mutation={rma}
          body={{ date: rmaDate, note: rmaNote.trim() === '' ? null : rmaNote.trim() }}
          onClose={close}
        >
          <Text>
            Record <strong className="mono">{drive.serial}</strong> as sent back to the vendor? It
            leaves {where ?? 'its slot'} and its pool membership ends.
          </Text>
          <TextInput
            label="Date"
            type="date"
            value={rmaDate}
            onChange={(e) => setRmaDate(e.currentTarget.value)}
            mt="sm"
          />
          <Textarea
            label="Note"
            autosize
            minRows={2}
            value={rmaNote}
            onChange={(e) => setRmaNote(e.currentTarget.value)}
            mt="sm"
          />
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
