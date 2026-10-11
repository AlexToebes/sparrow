import { Navigate, Route, Routes } from 'react-router';
import { AppShell } from './components/AppShell';
import { LayoutPage } from './pages/LayoutPage';
import { DrivesPage } from './pages/DrivesPage';
import { InboxPage } from './pages/InboxPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<LayoutPage />} />
        <Route path="drives" element={<DrivesPage />} />
        <Route path="drives/discovered" element={<InboxPage />} />
        <Route path="drives/inbox" element={<Navigate to="/drives/discovered" replace />} />
        <Route path="inbox" element={<Navigate to="/drives/discovered" replace />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<LayoutPage />} />
      </Route>
    </Routes>
  );
}
