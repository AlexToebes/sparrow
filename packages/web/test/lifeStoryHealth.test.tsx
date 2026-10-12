import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { LifeStory } from '../src/components/LifeStory';
import { act, ev } from './activities';
import { renderApp } from './utils';

afterEach(() => vi.unstubAllGlobals());

describe('life story health entries (R20)', () => {
  it('R20: shows each health entry as an icon plus text, never colour alone', async () => {
    const poll = (at: string, from: string | null, to: string) =>
      act('health-polled', at, null, [
        ev('health-changed', { drive: ['d1', 'ZL1'], payload: { from, to, reportedAt: at } }),
      ]);
    const activities = [
      poll('2026-03-06T00:00:00.000Z', 'ok', 'warning'),
      poll('2026-03-05T00:00:00.000Z', null, 'ok'),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        Response.json(String(url).includes('/history') ? activities : [], { status: 200 }),
      ),
    );
    renderApp(<LifeStory driveId="d1" />);
    const change = await screen.findByText(/Health: OK → Warning/);
    const first = screen.getByText(/Health first reported: OK/);
    expect(change.closest('.story-health')).toHaveAttribute('data-health', 'warning');
    expect(change.closest('.story-health')!.querySelector('svg')).not.toBeNull();
    expect(first.closest('.story-health')).toHaveAttribute('data-health', 'ok');
    expect(first.closest('.story-health')!.querySelector('svg')).not.toBeNull();
    // Oldest first.
    expect(first.compareDocumentPosition(change) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
