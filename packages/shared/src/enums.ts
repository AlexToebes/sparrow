import { z } from 'zod';

export const DRIVE_TYPES = ['HDD', 'SSD', 'NVMe'] as const;
export const DRIVE_STATUSES = ['spare', 'installed', 'retired'] as const;
export const DRIVE_CONDITIONS = ['new', 'used', 'tested'] as const;
export const RETIREMENT_REASONS = ['failed', 'replaced', 'other'] as const;
export const GRID_ORIENTATIONS = ['landscape', 'portrait'] as const;
export const MEMBERSHIP_ROLES = ['data', 'hot-spare'] as const;
export const MEMBERSHIP_SOURCES = ['manual', 'provider-suggested'] as const;
export const EVENT_TYPES = [
  'drive-created',
  'drive-updated',
  'drive-installed',
  'drive-removed',
  'drive-retired',
  'drive-reinstated',
  'drive-sent-for-rma',
  'drive-linked',
  'pool-joined',
  'pool-left',
  'pool-role-changed',
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
] as const;
export const HEALTH_VALUES = ['ok', 'warning', 'failed', 'unknown'] as const;
export const OBSERVATION_STATES = ['active', 'decommissioned'] as const;

export const driveTypeSchema = z.enum(DRIVE_TYPES);
export const driveStatusSchema = z.enum(DRIVE_STATUSES);
export const driveConditionSchema = z.enum(DRIVE_CONDITIONS);
export const retirementReasonSchema = z.enum(RETIREMENT_REASONS);
export const gridOrientationSchema = z.enum(GRID_ORIENTATIONS);
export const membershipRoleSchema = z.enum(MEMBERSHIP_ROLES);
export const membershipSourceSchema = z.enum(MEMBERSHIP_SOURCES);
export const eventTypeSchema = z.enum(EVENT_TYPES);
export const healthSchema = z.enum(HEALTH_VALUES);
export const observationStateSchema = z.enum(OBSERVATION_STATES);

export type DriveType = z.infer<typeof driveTypeSchema>;
export type DriveStatus = z.infer<typeof driveStatusSchema>;
export type DriveCondition = z.infer<typeof driveConditionSchema>;
export type RetirementReason = z.infer<typeof retirementReasonSchema>;
export type GridOrientation = z.infer<typeof gridOrientationSchema>;
export type MembershipRole = z.infer<typeof membershipRoleSchema>;
export type MembershipSource = z.infer<typeof membershipSourceSchema>;
export type EventType = z.infer<typeof eventTypeSchema>;
export type Health = z.infer<typeof healthSchema>;
export type ObservationState = z.infer<typeof observationStateSchema>;
