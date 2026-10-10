import { Route, Routes } from 'react-router';
import { AppShell } from './components/AppShell';
import { LayoutPage } from './pages/LayoutPage';
import { DrivesPage } from './pages/DrivesPage';
import { InboxPage } from './pages/Placeholders';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<LayoutPage />} />
        <Route path="drives" element={<DrivesPage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<LayoutPage />} />
      </Route>
    </Routes>
  );
}
