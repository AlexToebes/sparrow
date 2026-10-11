import { useState } from 'react';
import { Button, Text, Textarea } from '@mantine/core';
import type { Drive, SlotFlag } from '@sparrow/shared';
import { useDriveAction } from '../api/driveMutations';
import { ConfirmDialog } from './ConfirmDialog';
import { RemoveToSparesDialog } from './RemoveToSparesDialog';
import { RetireDialog } from './RetireDialog';
import { OptionalDateField } from './OptionalDateField';
import { RETIREMENT_DATE_HINT, retirementDateError } from './RetireFields';

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
  const rma = useDriveAction(drive.id, 'rma');
  const [rmaDate, setRmaDate] = useState('');
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
        <RemoveToSparesDialog
          drive={drive}
          where={where}
          title="Back to spares"
          confirmLabel="Move to spares"
          defaultRemovedOn=""
          onClose={close}
        >
          Check that it is really out of the NAS. The drive went missing at an unknown time, so the
          removal date starts empty.
        </RemoveToSparesDialog>
      ) : null}
      {outcome === 'retire' ? (
        <RetireDialog drive={drive} opened defaultDate="" onClose={close} />
      ) : null}
      {outcome === 'rma' ? (
        <ConfirmDialog
          title="Send for RMA"
          confirmLabel="Send for RMA"
          color="orange"
          mutation={rma}
          confirmDisabled={retirementDateError(rmaDate) !== null}
          body={{
            date: rmaDate === '' ? null : rmaDate,
            note: rmaNote.trim() === '' ? null : rmaNote.trim(),
          }}
          onClose={close}
        >
          <Text>
            Record <strong className="mono">{drive.serial}</strong> as sent back to the vendor? It
            leaves {where ?? 'its slot'} and its pool membership ends. It went missing at an unknown
            time, so the date starts empty.
          </Text>
          <OptionalDateField
            label="RMA date (optional)"
            description={RETIREMENT_DATE_HINT}
            value={rmaDate}
            onChange={setRmaDate}
            error={retirementDateError(rmaDate)}
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
