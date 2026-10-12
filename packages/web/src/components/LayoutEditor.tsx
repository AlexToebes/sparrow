import { useState } from 'react';
import { Button, Group, Modal, Text, TextInput } from '@mantine/core';
import type { CreateGridInput, LayoutEnclosure, LayoutGrid, LayoutSlot } from '@sparrow/shared';
import { useLayoutMutations } from '../api/settings';
import { useLayout } from '../api/hooks';
import { ApiErrorAlert } from './ApiErrorAlert';
import { BayGrid } from './BayGrid';
import { formatGridSize } from '../lib/grid';
import { GridForm } from './GridForm';

type Mutations = ReturnType<typeof useLayoutMutations>;

/** Settings > Layout (R38): enclosures, grids and slot labels. R40 blocks are shown, not hidden. */
export function LayoutEditor() {
  const layout = useLayout();
  const m = useLayoutMutations();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  return (
    <section className="card" aria-labelledby="layout-editor-title">
      <div className="card-head">
        <h2 className="card-title" id="layout-editor-title">
          Layout
        </h2>
      </div>
      <Text size="sm" c="dimmed" mb="md">
        Enclosures hold grids of bays. Shrinking or deleting a grid that still has drives in it is
        blocked until those drives are moved.
      </Text>
      {layout.isError ? (
        <ApiErrorAlert error={layout.error} title="Could not load the layout" />
      ) : null}
      {layout.data?.enclosures.map((e) => (
        <EnclosureEditor key={e.id} enclosure={e} m={m} />
      ))}
      {layout.data && layout.data.enclosures.length === 0 ? (
        <Text c="dimmed">No enclosures yet.</Text>
      ) : null}
      {adding ? (
        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            m.createEnclosure.mutate(
              { name },
              {
                onSuccess: () => {
                  setAdding(false);
                  setName('');
                },
              },
            );
          }}
        >
          <Group align="flex-end" mt="md">
            <TextInput
              label="Enclosure name"
              value={name}
              onChange={(ev) => setName(ev.target.value)}
              style={{ flex: 1, minWidth: 180 }}
            />
            <Button type="submit" loading={m.createEnclosure.isPending}>
              Add enclosure
            </Button>
            <Button variant="default" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </Group>
          <ApiErrorAlert error={m.createEnclosure.error} />
        </form>
      ) : (
        <Button
          variant="light"
          mt="md"
          onClick={() => {
            m.createEnclosure.reset();
            setAdding(true);
          }}
        >
          Add enclosure
        </Button>
      )}
    </section>
  );
}

function EnclosureEditor({ enclosure, m }: { enclosure: LayoutEnclosure; m: Mutations }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(enclosure.name);
  const [addingGrid, setAddingGrid] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="enclosure" role="group" aria-label={`Enclosure ${enclosure.name}`}>
      <div className="enclosure-head">
        {renaming ? (
          <form
            className="inline-form"
            onSubmit={(ev) => {
              ev.preventDefault();
              m.renameEnclosure.mutate(
                { id: enclosure.id, name },
                { onSuccess: () => setRenaming(false) },
              );
            }}
          >
            <TextInput
              aria-label="Enclosure name"
              value={name}
              onChange={(ev) => setName(ev.target.value)}
            />
            <Button type="submit" size="xs" loading={m.renameEnclosure.isPending}>
              Save
            </Button>
            <Button size="xs" variant="default" onClick={() => setRenaming(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <>
            <h3 className="enclosure-title">{enclosure.name}</h3>
            <Group gap="xs">
              <Button
                size="xs"
                variant="default"
                onClick={() => {
                  m.renameEnclosure.reset();
                  setName(enclosure.name);
                  setRenaming(true);
                }}
              >
                Rename
              </Button>
              <Button
                size="xs"
                variant="default"
                color="red"
                onClick={() => {
                  m.deleteEnclosure.reset();
                  setConfirmDelete(true);
                }}
              >
                Delete
              </Button>
            </Group>
          </>
        )}
      </div>
      <ApiErrorAlert error={m.renameEnclosure.error} />
      <ApiErrorAlert error={m.deleteEnclosure.error} title="Enclosure not deleted" />
      <Modal
        opened={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete enclosure?"
      >
        <Text>
          Delete {enclosure.name} and its {enclosure.grids.length} grid(s)? Its empty bays are
          removed. This cannot be undone.
        </Text>
        <Group mt="md" justify="flex-end">
          <Button variant="default" onClick={() => setConfirmDelete(false)}>
            Keep it
          </Button>
          <Button
            color="red"
            loading={m.deleteEnclosure.isPending}
            onClick={() =>
              m.deleteEnclosure.mutate(enclosure.id, { onSettled: () => setConfirmDelete(false) })
            }
          >
            Delete enclosure
          </Button>
        </Group>
      </Modal>

      {enclosure.grids.map((g) => (
        <GridEditor key={g.id} grid={g} m={m} />
      ))}

      {addingGrid ? (
        <div className="grid-edit">
          <GridForm
            initial={{ name: '', rows: 2, columns: 4, orientation: 'landscape' }}
            submitLabel="Add grid"
            pending={m.createGrid.isPending}
            onCancel={() => setAddingGrid(false)}
            onSubmit={(body: CreateGridInput) =>
              m.createGrid.mutate(
                { enclosureId: enclosure.id, body },
                { onSuccess: () => setAddingGrid(false) },
              )
            }
          />
          <ApiErrorAlert error={m.createGrid.error} />
        </div>
      ) : (
        <Button
          size="xs"
          variant="light"
          onClick={() => {
            m.createGrid.reset();
            setAddingGrid(true);
          }}
        >
          Add grid
        </Button>
      )}
    </div>
  );
}

function GridEditor({ grid, m }: { grid: LayoutGrid; m: Mutations }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const occupied = grid.slots.filter((s) => s.driveId !== null).length;

  return (
    <div className="grid-editor" role="group" aria-label={`Grid ${grid.name}`}>
      <div className="enclosure-head">
        <div>
          <strong>{grid.name}</strong>
          <span className="dim">
            {' '}
            {formatGridSize(grid.rows, grid.columns, grid.orientation)} · {grid.orientation} ·{' '}
            {occupied} of {grid.slots.length} occupied
          </span>
        </div>
        <Group gap="xs">
          <Button
            size="xs"
            variant="default"
            onClick={() => {
              m.updateGrid.reset();
              setEditing((v) => !v);
            }}
          >
            {editing ? 'Close' : 'Edit grid'}
          </Button>
          <Button
            size="xs"
            variant="default"
            onClick={() => {
              m.deleteGrid.reset();
              setConfirmDelete(true);
            }}
          >
            Delete grid
          </Button>
        </Group>
      </div>
      {editing ? (
        <div className="grid-edit">
          <GridForm
            initial={{
              name: grid.name,
              rows: grid.rows,
              columns: grid.columns,
              orientation: grid.orientation,
            }}
            submitLabel="Save grid"
            pending={m.updateGrid.isPending}
            onCancel={() => setEditing(false)}
            onSubmit={(body) =>
              m.updateGrid.mutate({ id: grid.id, body }, { onSuccess: () => setEditing(false) })
            }
          />
        </div>
      ) : null}
      <ApiErrorAlert error={m.updateGrid.error} title="Grid not changed" />
      <ApiErrorAlert error={m.deleteGrid.error} title="Grid not deleted" />
      <ApiErrorAlert error={m.updateSlotLabel.error} title="Label not saved" />
      <Modal opened={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete grid?">
        <Text>
          Delete the grid {grid.name} and its {grid.slots.length} bays? This cannot be undone.
        </Text>
        <Group mt="md" justify="flex-end">
          <Button variant="default" onClick={() => setConfirmDelete(false)}>
            Keep it
          </Button>
          <Button
            color="red"
            loading={m.deleteGrid.isPending}
            onClick={() =>
              m.deleteGrid.mutate(grid.id, { onSettled: () => setConfirmDelete(false) })
            }
          >
            Delete grid
          </Button>
        </Group>
      </Modal>
      <BayGrid
        rows={grid.rows}
        columns={grid.columns}
        orientation={grid.orientation}
        slots={grid.slots}
        label={`${grid.name} slot labels`}
        renderSlot={(s) => <SlotLabelInput slot={s} m={m} />}
      />
    </div>
  );
}

/** Inline label edit: saves on Enter or blur when changed. An empty label clears it (R39). */
function SlotLabelInput({ slot, m }: { slot: LayoutSlot; m: Mutations }) {
  const [value, setValue] = useState(slot.label ?? '');
  const [shown, setShown] = useState(slot.label ?? '');
  // Follow server changes (for example after a refetch) unless the user is mid-edit.
  if ((slot.label ?? '') !== shown) {
    setShown(slot.label ?? '');
    setValue(slot.label ?? '');
  }
  const save = () => {
    if (value.trim() === (slot.label ?? '')) return;
    m.updateSlotLabel.mutate({ id: slot.id, label: value });
  };
  return (
    <TextInput
      size="xs"
      aria-label={`Label for slot ${slot.position + 1}`}
      placeholder={`Slot ${slot.position + 1}`}
      value={value}
      maxLength={50}
      onChange={(ev) => setValue(ev.target.value)}
      onBlur={save}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter') save();
      }}
    />
  );
}
