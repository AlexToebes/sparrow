import { Text } from '@mantine/core';

function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <section className="card">
      <h2 className="card-title">{title}</h2>
      <Text c="dimmed" mt="xs">
        {note}
      </Text>
    </section>
  );
}

export const DrivesPage = () => (
  <Placeholder title="Drives" note="The drive list and drive pages arrive in a later step." />
);
export const InboxPage = () => (
  <Placeholder title="Inbox" note="New drives found by the provider will be resolved here." />
);
export const SettingsPage = () => (
  <Placeholder title="Settings" note="Layout editing, pools and export arrive in a later step." />
);
