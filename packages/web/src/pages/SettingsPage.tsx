import { BackupSection } from '../components/BackupSection';
import { ConfigSection } from '../components/ConfigSection';
import { LayoutEditor } from '../components/LayoutEditor';
import { PoolsSection } from '../components/PoolsSection';

export function SettingsPage() {
  return (
    <>
      <h1 className="page-title">Settings</h1>
      <LayoutEditor />
      <PoolsSection />
      <BackupSection />
      <ConfigSection />
    </>
  );
}
