import { useState } from 'react';
import { Button, NumberInput, SegmentedControl, Stack, Text, TextInput } from '@mantine/core';
import { useNavigate } from 'react-router';
import { setupInputSchema, type GridOrientation } from '@sparrow/shared';
import { useInbox, useProviderStatus } from '../api/hooks';
import { useCompleteSetup, useSkipSetup } from '../api/setup';
import { formatGridSize } from '../lib/grid';
import {
  effectiveLabels,
  gridFromPreset,
  gridProblem,
  GRID_PRESETS,
  newPool,
  poolProblem,
  toSetupInput,
  WIZARD_MAX_DIMENSION,
  type DraftGrid,
  type DraftPool,
} from '../lib/setup';
import { ApiErrorAlert } from './ApiErrorAlert';
import { BayGrid } from './BayGrid';
import { PoolFields } from './PoolForm';
import { StepFlow, type StepDef } from './StepFlow';

type StepKey = 'welcome' | 'enclosure' | 'grids' | 'pools' | 'review' | 'done';

const STEPS: StepDef<StepKey>[] = [
  { key: 'welcome', title: 'Welcome' },
  { key: 'enclosure', title: 'Name your enclosure' },
  { key: 'grids', title: 'Describe your bays' },
  { key: 'pools', title: 'Pools (optional)' },
  { key: 'review', title: 'Review' },
  { key: 'done', title: 'All set' },
];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * First-run setup wizard (R77): welcome, enclosure, grids with bay labels, optional pools, review,
 * done. Nothing is written until "Create", which makes everything in one request (one activity).
 * Skipping on the first step only remembers the choice.
 */
export function SetupWizard({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const provider = useProviderStatus();
  const inbox = useInbox();
  const create = useCompleteSetup();
  const skip = useSkipSetup();

  const [step, setStep] = useState<StepKey>('welcome');
  const [enclosureName, setEnclosureName] = useState('NAS');
  const [grids, setGrids] = useState<DraftGrid[]>([]);
  const [pools, setPools] = useState<DraftPool[]>([]);
  const [created, setCreated] = useState(false);

  const found =
    provider.data && provider.data.providerId !== 'none' ? provider.data.observationCount : 0;
  const discovered = inbox.data?.count ?? 0;

  const index = STEPS.findIndex((s) => s.key === step);
  const go = (delta: number) => setStep(STEPS[index + delta]!.key);

  const gridsValid = grids.length > 0 && grids.every((g) => gridProblem(g, grids) === null);
  const poolsValid = pools.every((p) => poolProblem(p, pools) === null);
  const valid =
    step === 'enclosure'
      ? enclosureName.trim() !== ''
      : step === 'grids'
        ? gridsValid
        : step === 'pools'
          ? poolsValid
          : true;

  const body = toSetupInput(enclosureName, grids, pools);
  const submit = () => {
    const parsed = setupInputSchema.safeParse(body);
    if (!parsed.success) return;
    create.mutate(body, {
      onSuccess: () => {
        setCreated(true);
        setStep('done');
      },
    });
  };

  let footer;
  if (step === 'welcome') {
    footer = (
      <>
        <Button
          variant="default"
          loading={skip.isPending}
          onClick={() => skip.mutate(undefined, { onSuccess: onClose })}
        >
          Skip, I&apos;ll set it up later
        </Button>
        <Button onClick={() => go(1)}>Start</Button>
      </>
    );
  } else if (step === 'done') {
    const target = discovered > 0 ? '/drives/discovered' : '/drives?add=1';
    footer = (
      <>
        <Button variant="default" onClick={onClose}>
          Close
        </Button>
        <Button
          onClick={() => {
            onClose();
            navigate(target);
          }}
        >
          {discovered > 0 ? 'Open Discovered drives' : 'Add a drive'}
        </Button>
      </>
    );
  } else {
    footer = (
      <>
        <Button variant="default" onClick={() => go(-1)}>
          Back
        </Button>
        {step === 'review' ? (
          <Button loading={create.isPending} onClick={submit}>
            Create
          </Button>
        ) : (
          <Button disabled={!valid} onClick={() => go(1)}>
            {step === 'pools' && pools.length === 0 ? 'Skip this step' : 'Next'}
          </Button>
        )}
      </>
    );
  }

  return (
    <StepFlow title="Set up Sparrow" steps={STEPS} current={step} onClose={onClose} footer={footer}>
      {step === 'welcome' ? (
        <Stack gap="sm">
          <Text>
            Sparrow shows where each drive physically sits in your NAS and keeps track of your cold
            spares and every drive&apos;s life.
          </Text>
          <Text>
            Setup takes about a minute: name your enclosure, describe its bays and, if you like, add
            your pools. You can change all of it later in Settings.
          </Text>
          {found > 0 ? (
            <Text className="setup-found" fw={600}>
              {capitalize(provider.data!.providerId)} found {plural(found, 'drive', 'drives')}. You
              can place them once your bays exist.
            </Text>
          ) : null}
          <ApiErrorAlert error={skip.error} />
        </Stack>
      ) : null}

      {step === 'enclosure' ? (
        <Stack gap="sm">
          <Text>What do you call the box your drives live in?</Text>
          <TextInput
            label="Enclosure name"
            description="For example NAS, Rack server or Desktop."
            required
            data-autofocus
            value={enclosureName}
            onChange={(e) => setEnclosureName(e.currentTarget.value)}
          />
        </Stack>
      ) : null}

      {step === 'grids' ? <GridsStep grids={grids} onChange={setGrids} /> : null}

      {step === 'pools' ? <PoolsStep pools={pools} onChange={setPools} /> : null}

      {step === 'review' ? (
        <Review enclosureName={enclosureName} grids={grids} pools={pools} />
      ) : null}
      {step === 'review' ? <ApiErrorAlert error={create.error} title="Could not create" /> : null}

      {step === 'done' && created ? (
        <Stack gap="sm">
          <Text fw={600}>
            {enclosureName.trim()} is ready with {plural(grids.length, 'grid', 'grids')}
            {pools.length > 0 ? ` and ${plural(pools.length, 'pool', 'pools')}` : ''}.
          </Text>
          <Text>
            {discovered > 0
              ? `Next: place your drives. ${plural(discovered, 'drive is', 'drives are')} waiting on the Discovered page.`
              : 'Next: place your drives. Add a drive, then give it a bay.'}
          </Text>
        </Stack>
      ) : null}
    </StepFlow>
  );
}

function GridsStep({
  grids,
  onChange,
}: {
  grids: DraftGrid[];
  onChange: (grids: DraftGrid[]) => void;
}) {
  const update = (key: string, patch: Partial<DraftGrid>) =>
    onChange(grids.map((g) => (g.key === key ? { ...g, ...patch } : g)));
  const move = (from: number, to: number) => {
    const next = [...grids];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    onChange(next);
  };
  return (
    <Stack gap="sm">
      <Text>
        Add a grid for each group of bays that sits together, for example the front bays or the
        internal SSDs. Pick a shape to start from.
      </Text>
      <div className="preset-chips" role="group" aria-label="Add a grid">
        {GRID_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className="preset-chip"
            onClick={() => onChange([...grids, gridFromPreset(p.id, grids)])}
          >
            + {p.chip}
          </button>
        ))}
      </div>
      {grids.length === 0 ? (
        <Text c="dimmed" size="sm">
          No grids yet. Add at least one to continue.
        </Text>
      ) : null}
      {grids.map((g, i) => (
        <GridDraftCard
          key={g.key}
          grid={g}
          all={grids}
          position={i}
          count={grids.length}
          onChange={(patch) => update(g.key, patch)}
          onRemove={() => onChange(grids.filter((x) => x !== g))}
          onMove={(to) => move(i, to)}
        />
      ))}
    </Stack>
  );
}

function GridDraftCard({
  grid,
  all,
  position,
  count,
  onChange,
  onRemove,
  onMove,
}: {
  grid: DraftGrid;
  all: DraftGrid[];
  position: number;
  count: number;
  onChange: (patch: Partial<DraftGrid>) => void;
  onRemove: () => void;
  onMove: (to: number) => void;
}) {
  const problem = gridProblem(grid, all);
  const rows = typeof grid.rows === 'number' ? grid.rows : 0;
  const columns = typeof grid.columns === 'number' ? grid.columns : 0;
  const previewOk =
    rows >= 1 && columns >= 1 && rows <= WIZARD_MAX_DIMENSION && columns <= WIZARD_MAX_DIMENSION;
  const labels = effectiveLabels(grid);
  const slots = previewOk ? labels.map((_, i) => ({ id: String(i), position: i })) : [];
  const title = grid.name.trim() || 'New grid';
  return (
    <section className="card setup-grid" aria-label={`Grid ${title}`}>
      <div className="card-head">
        <h3 className="card-title">{title}</h3>
        <div className="card-meta">
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            disabled={position === 0}
            onClick={() => onMove(position - 1)}
            aria-label={`Move ${title} up`}
          >
            Up
          </Button>
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            disabled={position === count - 1}
            onClick={() => onMove(position + 1)}
            aria-label={`Move ${title} down`}
          >
            Down
          </Button>
          <Button
            size="compact-xs"
            variant="subtle"
            color="red"
            onClick={onRemove}
            aria-label={`Remove ${title}`}
          >
            Remove
          </Button>
        </div>
      </div>
      <Stack gap="sm">
        <TextInput
          label="Grid name"
          value={grid.name}
          onChange={(e) => onChange({ name: e.currentTarget.value })}
        />
        <div className="setup-dims">
          <NumberInput
            label="Columns"
            min={1}
            max={WIZARD_MAX_DIMENSION}
            allowDecimal={false}
            value={grid.columns}
            onChange={(v) => onChange({ columns: v })}
          />
          <NumberInput
            label="Rows"
            min={1}
            max={WIZARD_MAX_DIMENSION}
            allowDecimal={false}
            value={grid.rows}
            onChange={(v) => onChange({ rows: v })}
          />
        </div>
        <div>
          <Text size="sm" fw={500} mb={4}>
            Orientation
          </Text>
          <SegmentedControl
            value={grid.orientation}
            onChange={(v) => onChange({ orientation: v as GridOrientation })}
            data={[
              { value: 'landscape', label: 'Landscape' },
              { value: 'portrait', label: 'Portrait' },
            ]}
            aria-label={`Orientation of ${title}`}
          />
        </div>
        {problem ? (
          <Text c="red" size="sm" role="alert">
            {problem}
          </Text>
        ) : null}
        {slots.length > 0 ? (
          <div>
            <Text size="sm" fw={500} mb={4}>
              Bays, shown as {formatGridSize(rows, columns, grid.orientation)}
            </Text>
            <BayGrid
              rows={rows}
              columns={columns}
              orientation={grid.orientation}
              slots={slots}
              label={`${title} bays`}
              renderSlot={(s) => (
                <input
                  className="label-input"
                  aria-label={`Label for bay ${s.position + 1} in ${title}`}
                  value={labels[s.position]}
                  maxLength={50}
                  onChange={(e) =>
                    onChange({ labels: { ...grid.labels, [s.position]: e.currentTarget.value } })
                  }
                  onFocus={(e) => e.currentTarget.select()}
                />
              )}
            />
            <Text size="xs" c="dimmed" mt={6}>
              Tap a bay to rename it, for example Left or Right. Clear it for no label.
            </Text>
          </div>
        ) : null}
      </Stack>
    </section>
  );
}

function PoolsStep({
  pools,
  onChange,
}: {
  pools: DraftPool[];
  onChange: (pools: DraftPool[]) => void;
}) {
  const update = (key: string, patch: Partial<DraftPool>) =>
    onChange(pools.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  return (
    <Stack gap="sm">
      <Text>
        A pool is a group of drives that work together, such as a ZFS or RAID set. Add yours now or
        skip this step and add them later on the Pools page.
      </Text>
      {pools.map((p) => {
        const problem = poolProblem(p, pools);
        return (
          <section key={p.key} className="card setup-grid" aria-label={`Pool ${p.name || 'new'}`}>
            <div className="card-head">
              <h3 className="card-title">{p.name.trim() || 'New pool'}</h3>
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                onClick={() => onChange(pools.filter((x) => x !== p))}
                aria-label={`Remove ${p.name.trim() || 'new pool'}`}
              >
                Remove
              </Button>
            </div>
            <PoolFields
              name={p.name}
              label={p.layoutLabel}
              expected={p.expected}
              onName={(name) => update(p.key, { name })}
              onLabel={(layoutLabel) => update(p.key, { layoutLabel })}
              onExpected={(expected) => update(p.key, { expected })}
              autoFocus={false}
            />
            {problem && p.name.trim() !== '' ? (
              <Text c="red" size="sm" mt="xs" role="alert">
                {problem}
              </Text>
            ) : null}
          </section>
        );
      })}
      <div>
        <Button variant="light" onClick={() => onChange([...pools, newPool()])}>
          Add a pool
        </Button>
      </div>
    </Stack>
  );
}

function Review({
  enclosureName,
  grids,
  pools,
}: {
  enclosureName: string;
  grids: DraftGrid[];
  pools: DraftPool[];
}) {
  return (
    <Stack gap="md">
      <Text>Sparrow will create this. Nothing is saved until you press Create.</Text>
      <div>
        <Text size="sm" c="dimmed">
          Enclosure
        </Text>
        <Text fw={600}>{enclosureName.trim()}</Text>
      </div>
      <div>
        <Text size="sm" c="dimmed">
          Grids
        </Text>
        <ul className="review-list">
          {grids.map((g) => {
            const labels = effectiveLabels(g);
            return (
              <li key={g.key}>
                <strong>{g.name.trim()}</strong>:{' '}
                {formatGridSize(Number(g.rows), Number(g.columns), g.orientation)},{' '}
                {plural(labels.length, 'bay', 'bays')}
                <span className="review-labels">
                  {' '}
                  ({labels.slice(0, 12).join(', ')}
                  {labels.length > 12 ? ', …' : ''})
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      <div>
        <Text size="sm" c="dimmed">
          Pools
        </Text>
        {pools.length === 0 ? (
          <Text>No pools. You can add them later on the Pools page.</Text>
        ) : (
          <ul className="review-list">
            {pools.map((p) => (
              <li key={p.key}>
                <strong>{p.name.trim()}</strong>
                {p.layoutLabel.trim() ? `, ${p.layoutLabel.trim()}` : ''}
                {p.expected.trim()
                  ? `, ${plural(Number(p.expected), 'drive', 'drives')} expected`
                  : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Stack>
  );
}
