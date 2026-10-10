import { Route, Routes } from 'react-router';
import { AppShell } from './components/AppShell';
import { LayoutPage } from './pages/LayoutPage';
import { DrivesPage, InboxPage, SettingsPage } from './pages/Placeholders';

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
