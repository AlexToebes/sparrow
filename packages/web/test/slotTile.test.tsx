import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from './user';
import { MantineProvider } from '@mantine/core';
import type { SlotStatus } from '@sparrow/shared';
import { SlotTile } from '../src/components/SlotTile';
import { buildSlotView } from '../src/lib/health';
import { makeDrive, makeSlot } from './utils';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const drive = makeDrive({ id: 'd1', serial: 'ZL2ABC01', slotId: 's1' });
const slot = makeSlot({ id: 's1', position: 0, label: 'Bay 1', driveId: 'd1' });
const status = (over: Partial<SlotStatus> = {}): SlotStatus => ({
  slotId: 's1',
  driveId: 'd1',
  health: 'ok',
  lastReportedAt: '2026-10-10T11:58:00.000Z',
  temperatureC: 31,
  detailUrl: null,
  stale: false,
  flag: null,
  ...over,
});

function tile(view: ReturnType<typeof buildSlotView>, onSelect = vi.fn()) {
  render(
    <MantineProvider>
      <SlotTile view={view} onSelect={onSelect} />
    </MantineProvider>,
  );
  return onSelect;
}

describe('SlotTile states (R18, D8)', () => {
  it('healthy: label, word, capacity and serial', () => {
    tile(buildSlotView(slot, drive, status(), NOW));
    expect(screen.getByText('Bay 1')).toBeInTheDocument();
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText('4 TB')).toBeInTheDocument();
    expect(screen.getByText('ZL2ABC01')).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute('data-state', 'ok');
  });

  it('failed and warning carry a word, not just a color', () => {
    tile(buildSlotView(slot, drive, status({ health: 'failed' }), NOW));
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('empty slot: dashed style, "Empty" and an assign hint, no serial', () => {
    tile(buildSlotView(makeSlot({ id: 's2', position: 1 }), null, null, NOW));
    expect(screen.getByRole('button')).toHaveAttribute('data-state', 'empty');
    expect(screen.getByText('Empty')).toBeInTheDocument();
    expect(screen.getByText('Slot 2')).toBeInTheDocument();
    expect(screen.getByText(/Assign/)).toBeInTheDocument();
  });

  it('R10/R27: a flagged slot shows "Missing" and the reason, and still shows the drive', () => {
    tile(
      buildSlotView(
        slot,
        drive,
        status({ flag: { kind: 'missing', reason: 'decommissioned' } }),
        NOW,
      ),
    );
    expect(screen.getByRole('button')).toHaveAttribute('data-state', 'missing');
    expect(screen.getByText('Missing')).toBeInTheDocument();
    expect(screen.getByText('Decommissioned')).toBeInTheDocument();
    expect(screen.getByText('ZL2ABC01')).toBeInTheDocument();
  });

  it('R18: a stale slot is labelled stale with its age and last known health, never hidden', () => {
    tile(
      buildSlotView(
        slot,
        drive,
        status({ stale: true, lastReportedAt: '2026-10-07T12:00:00.000Z' }),
        NOW,
      ),
    );
    expect(screen.getByRole('button')).toHaveAttribute('data-state', 'ok');
    expect(screen.getByRole('button')).toHaveAttribute('data-stale', 'true');
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText('Stale, seen 3 d ago')).toBeInTheDocument();
  });

  it('F1/R18: a stale failed drive keeps its Failed state and word, with stale on top', () => {
    tile(
      buildSlotView(
        slot,
        drive,
        status({ health: 'failed', stale: true, lastReportedAt: '2026-10-07T12:00:00.000Z' }),
        NOW,
      ),
    );
    expect(screen.getByRole('button')).toHaveAttribute('data-state', 'failed');
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Stale, seen 3 d ago')).toBeInTheDocument();
  });

  it('without provider data an occupied slot reads as unknown', () => {
    tile(buildSlotView(slot, drive, null, NOW));
    expect(screen.getByRole('button')).toHaveAttribute('data-state', 'unknown');
    expect(screen.getByText('No data')).toBeInTheDocument();
  });

  it('click selects the slot', async () => {
    const onSelect = tile(buildSlotView(slot, drive, status(), NOW));
    await userEvent.click(screen.getByRole('button'));
    expect(onSelect).toHaveBeenCalledWith('s1');
  });
});
