import { Link } from 'react-router';
import { BackupSection } from '../components/BackupSection';
import { ConfigSection } from '../components/ConfigSection';
import { LayoutEditor } from '../components/LayoutEditor';

export function SettingsPage() {
  return (
    <>
      <h1 className="page-title">Settings</h1>
      <p>
        <Link to="/activity">Recent changes</Link> shows everything that happened in the enclosure.
      </p>
      <LayoutEditor />
      <BackupSection />
      <ConfigSection />
    </>
  );
}
