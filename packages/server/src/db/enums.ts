// Local copies of the enum value lists from the Step 1 data-model contract.
// They will be replaced by imports from @sparrow/shared in a later integration pass.
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
] as const;
