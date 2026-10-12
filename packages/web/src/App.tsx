import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { Center, Loader } from '@mantine/core';
import { AppShell } from './components/AppShell';

// F24: each page is its own chunk, loaded on first visit, so the first paint ships less script.
const LayoutPage = lazy(() =>
  import('./pages/LayoutPage').then((m) => ({ default: m.LayoutPage })),
);
const DrivesPage = lazy(() =>
  import('./pages/DrivesPage').then((m) => ({ default: m.DrivesPage })),
);
const InboxPage = lazy(() => import('./pages/InboxPage').then((m) => ({ default: m.InboxPage })));
const PoolsPage = lazy(() => import('./pages/PoolsPage').then((m) => ({ default: m.PoolsPage })));
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);

function PageFallback() {
  return (
    <Center py="xl" role="status" aria-label="Loading page">
      <Loader size="sm" />
    </Center>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route
          index
          element={
            <Page>
              <LayoutPage />
            </Page>
          }
        />
        <Route
          path="drives"
          element={
            <Page>
              <DrivesPage />
            </Page>
          }
        />
        <Route
          path="drives/discovered"
          element={
            <Page>
              <InboxPage />
            </Page>
          }
        />
        <Route path="drives/inbox" element={<Navigate to="/drives/discovered" replace />} />
        <Route path="inbox" element={<Navigate to="/drives/discovered" replace />} />
        <Route
          path="pools"
          element={
            <Page>
              <PoolsPage />
            </Page>
          }
        />
        <Route
          path="settings"
          element={
            <Page>
              <SettingsPage />
            </Page>
          }
        />
        <Route
          path="*"
          element={
            <Page>
              <LayoutPage />
            </Page>
          }
        />
      </Route>
    </Routes>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PageFallback />}>{children}</Suspense>;
}
