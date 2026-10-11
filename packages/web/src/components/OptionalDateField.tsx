import { Button, Group, TextInput } from '@mantine/core';
import { todayLocal } from './dates';

/** A `type="date"` field that may be left empty ("not recorded"), with Today and Clear shortcuts (R68, R69). */
export function OptionalDateField({
  label,
  description,
  value,
  onChange,
  error,
  mt = 'sm',
  id,
}: {
  label: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  mt?: string;
  id?: string;
}) {
  return (
    <TextInput
      id={id}
      label={label}
      description={description}
      type="date"
      mt={mt}
      max={todayLocal()}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      error={error}
      rightSectionWidth={150}
      rightSection={
        <Group gap={4} wrap="nowrap">
          <Button size="compact-xs" variant="subtle" onClick={() => onChange(todayLocal())}>
            Today
          </Button>
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            disabled={value === ''}
            onClick={() => onChange('')}
          >
            Clear
          </Button>
        </Group>
      }
    />
  );
}

/** Hint for the installation, removal and swap dates (R68, R69). */
export const NOT_RECORDED_HINT =
  'Leave empty if you don’t know — it’s better to show ‘not recorded’ than a guess.';
