import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { LifeStory } from '../src/components/LifeStory';
import { renderApp } from './utils';

afterEach(() => vi.unstubAllGlobals());

describe('life story health entries (R20)', () => {
  it('R20: shows each health entry as an icon plus text, never colour alone', async () => {
    const events = [
      {
        id: 'e2',
        driveId: 'd1',
        type: 'health-changed',
        at: '2026-03-06T00:00:00.000Z',
        payload: { from: 'ok', to: 'warning', reportedAt: '2026-03-06T00:00:00.000Z' },
      },
      {
        id: 'e1',
        driveId: 'd1',
        type: 'health-changed',
        at: '2026-03-05T00:00:00.000Z',
        payload: { from: null, to: 'ok', reportedAt: '2026-03-05T00:00:00.000Z' },
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        Response.json(String(url).includes('/events') ? events : [], { status: 200 }),
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
