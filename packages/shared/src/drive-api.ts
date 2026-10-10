import { z } from 'zod';
import { driveSchema } from './drive.js';
import { driveStatusSchema } from './enums.js';

// Request bodies for the drive API (R11, R13, R26, D5). Field definitions are reused from driveSchema.
// Status, slot and retirement fields are deliberately absent: they change only through explicit
// actions (installation, retirement, reinstating), never through create or edit (R13, R14).

const fields = driveSchema.shape;

const serialInput = z.string().trim().pipe(fields.serial);

const editableFields = {
  model: fields.model.optional(),
  capacityBytes: fields.capacityBytes.optional(),
  driveType: fields.driveType.optional(),
  formFactor: fields.formFactor.optional(),
  storageLocation: fields.storageLocation.optional(),
  condition: fields.condition.optional(),
  lastTestDate: fields.lastTestDate.optional(),
  purchaseDate: fields.purchaseDate.optional(),
  warrantyExpiry: fields.warrantyExpiry.optional(),
  vendor: fields.vendor.optional(),
  notes: fields.notes.optional(),
};

/** POST /api/drives. Creates a spare only; serial is required, everything else is optional (R21). */
export const createDriveInputSchema = z.strictObject({
  serial: serialInput,
  ...editableFields,
});
export type CreateDriveInput = z.infer<typeof createDriveInputSchema>;

/** PATCH /api/drives/:id. Edits R11 fields only; an empty object is a valid no-op. */
export const updateDriveInputSchema = z.strictObject({
  serial: serialInput.optional(),
  ...editableFields,
});
export type UpdateDriveInput = z.infer<typeof updateDriveInputSchema>;

/** GET /api/drives. */
export const listDrivesQuerySchema = z.strictObject({
  status: driveStatusSchema.optional(),
});
export type ListDrivesQuery = z.infer<typeof listDrivesQuerySchema>;
