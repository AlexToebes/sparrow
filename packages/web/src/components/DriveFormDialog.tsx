import { useState } from 'react';
import { Alert, Button, Modal, Select, Textarea, TextInput } from '@mantine/core';
import {
  DRIVE_CONDITIONS,
  DRIVE_TYPES,
  createDriveInputSchema,
  updateDriveInputSchema,
  type Drive,
  type DriveCondition,
  type DriveType,
} from '@sparrow/shared';
import { ApiError } from '../api/client';
import { useCreateDrive, useUpdateDrive } from '../api/driveMutations';
import { parseCapacity, splitCapacity, type CapacityUnit } from '../lib/capacity';

interface DriveFormDialogProps {
  /** Present when editing. */
  drive?: Drive;
  onClose: () => void;
  onSaved?: (drive: Drive) => void;
}

interface FormState {
  serial: string;
  model: string;
  capacity: string;
  unit: CapacityUnit;
  driveType: DriveType | null;
  formFactor: string;
  storageLocation: string;
  condition: DriveCondition | null;
  lastTestDate: string;
  purchaseDate: string;
  warrantyExpiry: string;
  vendor: string;
  notes: string;
}

const text = (v: string | null) => v ?? '';
const blank = (s: string): string | null => (s.trim() === '' ? null : s.trim());

function initial(d?: Drive): FormState {
  const cap = splitCapacity(d?.capacityBytes ?? null);
  return {
    serial: d?.serial ?? '',
    model: text(d?.model ?? null),
    capacity: cap.text,
    unit: cap.unit,
    driveType: d?.driveType ?? null,
    formFactor: text(d?.formFactor ?? null),
    storageLocation: text(d?.storageLocation ?? null),
    condition: d?.condition ?? null,
    lastTestDate: text(d?.lastTestDate ?? null),
    purchaseDate: text(d?.purchaseDate ?? null),
    warrantyExpiry: text(d?.warrantyExpiry ?? null),
    vendor: text(d?.vendor ?? null),
    notes: text(d?.notes ?? null),
  };
}

/** Create or edit a drive (R11, R13). Cleared fields are sent as null. Mount only while open. */
export function DriveFormDialog({ drive, onClose, onSaved }: DriveFormDialogProps) {
  const create = useCreateDrive();
  const update = useUpdateDrive(drive?.id ?? '');
  const [f, setF] = useState<FormState>(() => initial(drive));
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<FormState>) => setF((s) => ({ ...s, ...patch }));

  const submit = () => {
    const bytes = parseCapacity(f.capacity, f.unit);
    if (Number.isNaN(bytes)) {
      setError('Capacity must be a number, for example 4 or 1.92.');
      return;
    }
    const fields = {
      model: blank(f.model),
      capacityBytes: bytes,
      driveType: f.driveType,
      formFactor: blank(f.formFactor),
      storageLocation: blank(f.storageLocation),
      condition: f.condition,
      lastTestDate: blank(f.lastTestDate),
      purchaseDate: blank(f.purchaseDate),
      warrantyExpiry: blank(f.warrantyExpiry),
      vendor: blank(f.vendor),
      notes: blank(f.notes),
    };
    const parsed = drive
      ? updateDriveInputSchema.safeParse({
          // Only what changed, so an untouched field is never rewritten.
          ...(f.serial.trim() !== drive.serial ? { serial: f.serial } : {}),
          ...Object.fromEntries(
            Object.entries(fields).filter(
              ([k, v]) => v !== (drive[k as keyof typeof fields] ?? null),
            ),
          ),
        })
      : createDriveInputSchema.safeParse({ serial: f.serial, ...fields });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(
        issue?.path[0] === 'serial'
          ? 'Serial number is required.'
          : (issue?.message ?? 'Invalid input.'),
      );
      return;
    }
    setError(null);
    const opts = {
      onSuccess: (saved: Drive) => {
        onSaved?.(saved);
        onClose();
      },
      onError: (e: Error) =>
        setError(e instanceof ApiError ? e.message : 'Could not save the drive.'),
    };
    if (drive) update.mutate(parsed.data, opts);
    else create.mutate(parsed.data as Parameters<typeof create.mutate>[0], opts);
  };

  return (
    <Modal
      opened
      onClose={onClose}
      title={drive ? `Edit ${drive.serial}` : 'Add a drive'}
      centered
      size="lg"
    >
      <div className="form-grid">
        <TextInput
          className="span-2"
          label="Serial number"
          required
          value={f.serial}
          onChange={(e) => set({ serial: e.currentTarget.value })}
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
        />
        <TextInput
          label="Model"
          value={f.model}
          onChange={(e) => set({ model: e.currentTarget.value })}
        />
        <div className="cap-row">
          <TextInput
            label="Capacity"
            inputMode="decimal"
            value={f.capacity}
            onChange={(e) => set({ capacity: e.currentTarget.value })}
          />
          <Select
            aria-label="Capacity unit"
            data={['GB', 'TB']}
            value={f.unit}
            onChange={(v) => set({ unit: (v as CapacityUnit | null) ?? 'TB' })}
            allowDeselect={false}
            w={84}
            comboboxProps={{ withinPortal: false }}
          />
        </div>
        <Select
          label="Type"
          data={[...DRIVE_TYPES]}
          value={f.driveType}
          onChange={(v) => set({ driveType: v as DriveType | null })}
          clearable
          comboboxProps={{ withinPortal: false }}
        />
        <TextInput
          label="Form factor"
          placeholder='3.5"'
          value={f.formFactor}
          onChange={(e) => set({ formFactor: e.currentTarget.value })}
        />
        <TextInput
          label="Storage location"
          placeholder="Desk drawer"
          value={f.storageLocation}
          onChange={(e) => set({ storageLocation: e.currentTarget.value })}
        />
        <Select
          label="Condition"
          data={[...DRIVE_CONDITIONS]}
          value={f.condition}
          onChange={(v) => set({ condition: v as DriveCondition | null })}
          clearable
          comboboxProps={{ withinPortal: false }}
        />
        <TextInput
          label="Last test date"
          type="date"
          value={f.lastTestDate}
          onChange={(e) => set({ lastTestDate: e.currentTarget.value })}
        />
        <TextInput
          label="Purchase date"
          type="date"
          value={f.purchaseDate}
          onChange={(e) => set({ purchaseDate: e.currentTarget.value })}
        />
        <TextInput
          label="Warranty expiry"
          type="date"
          value={f.warrantyExpiry}
          onChange={(e) => set({ warrantyExpiry: e.currentTarget.value })}
        />
        <TextInput
          label="Vendor"
          value={f.vendor}
          onChange={(e) => set({ vendor: e.currentTarget.value })}
        />
        <Textarea
          className="span-2"
          label="Notes"
          autosize
          minRows={2}
          value={f.notes}
          onChange={(e) => set({ notes: e.currentTarget.value })}
        />
      </div>
      {error ? (
        <Alert color="red" mt="sm">
          {error}
        </Alert>
      ) : null}
      <div className="dialog-actions">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} loading={create.isPending || update.isPending}>
          {drive ? 'Save' : 'Add drive'}
        </Button>
      </div>
    </Modal>
  );
}
