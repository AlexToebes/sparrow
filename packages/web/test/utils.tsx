import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { theme } from '../src/theme';
import type { Drive, LayoutSlot } from '@sparrow/shared';

export function renderApp(ui: ReactElement, route = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MantineProvider theme={theme}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

const T = '2026-01-01T00:00:00.000Z';

export function makeSlot(over: Partial<LayoutSlot> & { id: string; position: number }): LayoutSlot {
  return { gridId: 'g1', label: null, driveId: null, createdAt: T, updatedAt: T, ...over };
}

export function makeDrive(over: Partial<Drive> & { id: string; serial: string }): Drive {
  return {
    serialNormalized: over.serial.toLowerCase(),
    wwn: null,
    model: 'TestModel',
    capacityBytes: 4_000_000_000_000,
    driveType: 'HDD',
    formFactor: null,
    storageLocation: null,
    condition: 'new',
    lastTestDate: null,
    purchaseDate: null,
    warrantyExpiry: null,
    vendor: null,
    notes: null,
    status: 'installed',
    slotId: null,
    retirementReason: null,
    retirementDate: null,
    replacedByDriveId: null,
    retirementNote: null,
    installedOn: null,
    createdAt: T,
    updatedAt: T,
    ...over,
    ...(over.installedOn === undefined && (over.status ?? 'installed') === 'installed'
      ? { installedOn: '2026-01-01' }
      : {}),
  };
}

/** Routes a fetch mock by URL path. Unknown paths answer 404 in the server's error shape. */
export function mockApi(routes: Record<string, unknown>) {
  const fn = (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url in routes) {
      return Promise.resolve(
        new Response(JSON.stringify(routes[url]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({ error: { code: 'not-found', message: `no mock for ${url}` } }),
        {
          status: 404,
        },
      ),
    );
  };
  globalThis.fetch = fn as typeof fetch;
}
