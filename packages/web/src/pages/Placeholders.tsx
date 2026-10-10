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

export const InboxPage = () => (
  <Placeholder title="Inbox" note="New drives found by the provider will be resolved here." />
);
