import { useState } from 'react';
import {
  Button,
  Group,
  NumberInput,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { createGridSchema, type CreateGridInput, type GridOrientation } from '@sparrow/shared';
import { BayGrid } from './BayGrid';

export interface GridFormProps {
  initial: CreateGridInput;
  submitLabel: string;
  pending?: boolean;
  onSubmit: (values: CreateGridInput) => void;
  onCancel: () => void;
}

/** Name, rows, columns and orientation with a live mini preview (R4, R7, R38). */
export function GridForm({ initial, submitLabel, pending, onSubmit, onCancel }: GridFormProps) {
  const [name, setName] = useState(initial.name);
  const [rows, setRows] = useState<number | string>(initial.rows);
  const [columns, setColumns] = useState<number | string>(initial.columns);
  const [orientation, setOrientation] = useState<GridOrientation>(initial.orientation);
  const [problem, setProblem] = useState<string | null>(null);

  const r = typeof rows === 'number' ? rows : 0;
  const c = typeof columns === 'number' ? columns : 0;
  const previewOk = r >= 1 && c >= 1 && r <= 12 && c <= 12;
  const previewSlots = previewOk
    ? Array.from({ length: r * c }, (_, i) => ({ id: String(i), position: i }))
    : [];

  const submit = () => {
    const parsed = createGridSchema.safeParse({ name, rows, columns, orientation });
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? 'Check the values');
      return;
    }
    setProblem(null);
    onSubmit(parsed.data);
  };

  return (
    <form
      className="grid-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Stack gap="sm">
        <TextInput label="Grid name" value={name} onChange={(e) => setName(e.target.value)} />
        <Group grow align="flex-start">
          <NumberInput
            label="Rows"
            min={1}
            max={100}
            allowDecimal={false}
            value={rows}
            onChange={setRows}
          />
          <NumberInput
            label="Columns"
            min={1}
            max={100}
            allowDecimal={false}
            value={columns}
            onChange={setColumns}
          />
        </Group>
        <div>
          <Text size="sm" fw={500} mb={4}>
            Orientation
          </Text>
          <SegmentedControl
            value={orientation}
            onChange={(v) => setOrientation(v as GridOrientation)}
            data={[
              { value: 'landscape', label: 'Landscape' },
              { value: 'portrait', label: 'Portrait' },
            ]}
            aria-label="Orientation"
          />
        </div>
        <div className="grid-preview" aria-label="Preview">
          {previewOk ? (
            <BayGrid
              rows={r}
              columns={c}
              orientation={orientation}
              slots={previewSlots}
              label="Preview"
              renderSlot={(s) => <div className="preview-cell">{s.position + 1}</div>}
            />
          ) : (
            <Text size="sm" c="dimmed">
              Preview shows up to 12 x 12.
            </Text>
          )}
        </div>
        {problem ? (
          <Text c="red" size="sm" role="alert">
            {problem}
          </Text>
        ) : null}
        <Group>
          <Button type="submit" loading={pending}>
            {submitLabel}
          </Button>
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
