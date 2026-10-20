import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import type { RetiredCandidate, SlotStatus } from '@sparrow/shared';
import { SparesShelf } from '../src/components/SparesShelf';
import { ImportRetiredPanel } from '../src/components/ImportRetiredPanel';
import { InboxEntryCard } from '../src/components/InboxEntryCard';
import { MissingDrivePanel } from '../src/components/MissingDrivePanel';
import { HealthMark } from '../src/pages/DrivesPage';
import { isObservationStale } from '../src/lib/observationAge';
import { makeDrive, mockApi, renderApp } from './utils';

const realMatchMedia = window.matchMedia;
function setPhone(phone: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion') || (phone && query.includes('max-width')),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
beforeEach(() => setPhone(true));
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

const spare = makeDrive({
  id: 'sp1',
  serial: 'WD-WMC6N0D7PHZ0-LONG-SERIAL',
  status: 'spare',
  model: 'WD Red',
  condition: 'tested',
  storageLocation: 'Closet box 2',
});

describe('F6: spares shelf on a phone', () => {
  it('shows cards with the serial in one piece, the location and an Assign button, no table', () => {
    mockApi({});
    renderApp(<SparesShelf spares={[spare]} />);
    expect(screen.queryByRole('table')).toBeNull();
    const list = screen.getByRole('list', { name: 'Spares' });
    expect(within(list).getByText('WD-WMC6N0D7PHZ0-LONG-SERIAL')).toBeVisible();
    expect(within(list).getByText('Closet box 2')).toBeVisible();
    expect(within(list).getByRole('button', { name: /^Assign WD-WMC/ })).toBeVisible();
  });

  it('keeps the table on a wide screen', () => {
    setPhone(false);
    mockApi({});
    renderApp(<SparesShelf spares={[spare]} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
});

const retired: RetiredCandidate[] = [
  {
    observationKey: 'R1',
    serial: 'RET-1',
    model: 'Old',
    capacityBytes: 2e12,
    driveType: 'HDD',
    retirementDate: '2024-03-04',
    healthHint: 'failed',
  },
];

describe('F7, R63: retired import on a phone', () => {
  it('shows each candidate as a card with its health hint, reason and date', () => {
    mockApi({});
    renderApp(<ImportRetiredPanel candidates={retired} />);
    expect(screen.queryByRole('table')).toBeNull();
    const list = screen.getByRole('list', { name: 'Retired drive candidates' });
    expect(within(list).getByText('Failed')).toBeVisible();
    expect(within(list).getByText('Last known health (hint)')).toBeVisible();
    expect(within(list).getByLabelText('Select RET-1')).toBeVisible();
    expect(within(list).getAllByLabelText('Reason for RET-1').length).toBeGreaterThan(0);
    expect(within(list).getByLabelText('Date for RET-1')).toHaveValue('2024-03-04');
  });
});

const status = (over: Record<string, unknown> = {}) => ({
  providerId: 'scrutiny',
  providerStale: false,
  staleAfterHours: 36,
  lastSuccessAt: new Date().toISOString(),
  slots: [],
  ...over,
});
const obs = (over: Record<string, unknown> = {}) => ({
  serial: 'NVME-1',
  model: 'Samsung',
  capacityBytes: 5e11,
  driveType: 'NVMe',
  health: 'ok',
  lastReportedAt: new Date(Date.now() - 90 * 86_400_000).toISOString(),
  state: 'active',
  ...over,
});

describe('F8, R18, R47: discovered drive health', () => {
  it('an observation older than the stale threshold is labelled stale with its last known health', async () => {
    mockApi({ '/api/drives?status=spare': [spare], '/api/status': status() });
    renderApp(
      <InboxEntryCard
        entry={{ observationKey: 'K', observation: obs() as never, suggestion: null }}
      />,
    );
    expect(await screen.findByText(/Stale · last known Healthy/)).toBeVisible();
    expect(screen.queryByText('Healthy')).toBeNull();
    expect(screen.getByText(/Last reported 3 mo ago/)).toBeVisible();
  });

  it('a fresh observation keeps its plain health badge', async () => {
    mockApi({ '/api/drives?status=spare': [spare], '/api/status': status() });
    renderApp(
      <InboxEntryCard
        entry={{
          observationKey: 'K',
          observation: obs({ lastReportedAt: new Date().toISOString() }) as never,
          suggestion: null,
        }}
      />,
    );
    expect(await screen.findByText('Healthy')).toBeVisible();
    expect(screen.queryByText(/Stale/)).toBeNull();
  });

  it('isObservationStale: unknown threshold means not stale; never reported is stale', () => {
    const now = Date.parse('2026-10-12T00:00:00Z');
    expect(isObservationStale('2026-01-01T00:00:00Z', undefined, now)).toBe(false);
    expect(isObservationStale('2026-10-11T12:00:00Z', 36, now)).toBe(false);
    expect(isObservationStale('2026-10-10T00:00:00Z', 36, now)).toBe(true);
    expect(isObservationStale(null, 36, now)).toBe(true);
  });
});

const inboxBody = { entries: [], unidentified: [], retiredCandidates: [], count: 0 };

describe('F9: linking a discovered drive to a drive record', () => {
  it('with no spares, Link is disabled with a hint and Create is the primary action', async () => {
    mockApi({ '/api/drives': [], '/api/inbox': inboxBody, '/api/status': status() });
    renderApp(
      <InboxEntryCard
        entry={{
          observationKey: 'K',
          observation: obs({ lastReportedAt: new Date().toISOString() }) as never,
          suggestion: null,
        }}
      />,
    );
    const link = await screen.findByRole('button', { name: 'Link to a drive' });
    await screen.findByText(/no drive record to link/i);
    expect(link).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create new record' })).toBeEnabled();
  });
});

describe('F16: health and missing copy', () => {
  const st = (over: Partial<SlotStatus>): SlotStatus => ({
    slotId: 's',
    driveId: 'd',
    health: 'ok',
    lastReportedAt: new Date().toISOString(),
    temperatureC: null,
    detailUrl: null,
    stale: false,
    flag: null,
    ...over,
  });

  it('HealthMark: icon plus word, stale aware, never reported says so', () => {
    const { rerender } = renderApp(<HealthMark status={st({ health: 'warning' })} />);
    expect(screen.getByText('Warning')).toBeVisible();
    rerender(<HealthMark status={st({ stale: true, health: 'failed' })} />);
    expect(screen.getByText(/Stale, last failed/)).toBeVisible();
    rerender(<HealthMark status={st({ lastReportedAt: null, health: 'unknown' })} />);
    expect(screen.getByText(/Not reported/)).toBeVisible();
    rerender(<HealthMark status={st({ flag: { kind: 'missing', reason: 'stale' } })} />);
    expect(screen.getByText(/Missing/)).toBeVisible();
  });

  it('the missing panel does not say "no longer" for a drive that was never reported', () => {
    mockApi({});
    const d = makeDrive({ id: 'd0', serial: 'AAA0', slotId: 's0' });
    const { unmount } = renderApp(
      <MissingDrivePanel drive={d} reason="not-reported" where="Bay 1" neverReported />,
    );
    expect(screen.getByText(/has never reported this drive/)).toBeVisible();
    expect(screen.queryByText(/no longer reports/)).toBeNull();
    unmount();
    renderApp(<MissingDrivePanel drive={d} reason="not-reported" where="Bay 1" />);
    expect(screen.getByText(/no longer reports/)).toBeVisible();
  });
});
