import { z } from 'zod';

export const DRIVE_TYPES = ['HDD', 'SSD', 'NVMe'] as const;
export const DRIVE_STATUSES = ['spare', 'installed', 'retired'] as const;
export const DRIVE_CONDITIONS = ['new', 'used', 'tested'] as const;
export const RETIREMENT_REASONS = ['failed', 'replaced', 'other'] as const;
export const GRID_ORIENTATIONS = ['landscape', 'portrait'] as const;
export const MEMBERSHIP_ROLES = ['data', 'hot-spare'] as const;
/**
 * Atomic facts (R14). Each event concerns at most one drive, one slot and one pool; a user action
 * is an ACTIVITY (see ACTIVITY_KINDS) made of one or more events that happened together.
 */
export const EVENT_TYPES = [
  'drive-created',
  'drive-updated',
  'drive-linked',
  'drive-installed',
  'drive-uninstalled',
  'installation-updated',
  'pool-joined',
  'pool-left',
  'pool-role-changed',
  'drive-retired',
  'drive-sent-for-rma',
  'drive-reinstated',
  'health-changed',
  'suggestion-dismissed',
  'enclosure-created',
  'enclosure-renamed',
  'enclosure-deleted',
  'grid-created',
  'grid-updated',
  'grid-deleted',
  'slot-relabeled',
  'pool-created',
  'pool-updated',
  'pool-deleted',
  'conflict-added',
  'conflict-removed',
] as const;
/** One user (or system) action; the unit the history is read in (R14). */
export const ACTIVITY_KINDS = [
  'drive-added',
  'discovered-created',
  'discovered-linked',
  'retired-imported',
  'drive-edited',
  'suggestions-applied',
  'suggestions-dismissed',
  'suggestions-restored',
  'assigned',
  'replaced',
  'removed',
  'retired',
  'sent-for-rma',
  'reinstated',
  'moved',
  'swapped',
  'pool-joined',
  'pool-left',
  'pool-role-changed',
  'pool-changed',
  'health-polled',
  'layout-updated',
  'pool-edited',
  'conflict-added',
  'conflict-removed',
] as const;
export const HEALTH_VALUES = ['ok', 'warning', 'failed', 'unknown'] as const;
export const OBSERVATION_STATES = ['active', 'decommissioned'] as const;

export const driveTypeSchema = z.enum(DRIVE_TYPES);
export const driveStatusSchema = z.enum(DRIVE_STATUSES);
export const driveConditionSchema = z.enum(DRIVE_CONDITIONS);
export const retirementReasonSchema = z.enum(RETIREMENT_REASONS);
export const gridOrientationSchema = z.enum(GRID_ORIENTATIONS);
export const membershipRoleSchema = z.enum(MEMBERSHIP_ROLES);
export const eventTypeSchema = z.enum(EVENT_TYPES);
export const activityKindSchema = z.enum(ACTIVITY_KINDS);
export const healthSchema = z.enum(HEALTH_VALUES);
export const observationStateSchema = z.enum(OBSERVATION_STATES);

export type DriveType = z.infer<typeof driveTypeSchema>;
export type DriveStatus = z.infer<typeof driveStatusSchema>;
export type DriveCondition = z.infer<typeof driveConditionSchema>;
export type RetirementReason = z.infer<typeof retirementReasonSchema>;
export type GridOrientation = z.infer<typeof gridOrientationSchema>;
export type MembershipRole = z.infer<typeof membershipRoleSchema>;
export type EventType = z.infer<typeof eventTypeSchema>;
export type ActivityKind = z.infer<typeof activityKindSchema>;
export type Health = z.infer<typeof healthSchema>;
export type ObservationState = z.infer<typeof observationStateSchema>;
