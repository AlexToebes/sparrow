import { Text } from '@mantine/core';
import { useHealth } from '../api/settings';

/** Settings > About: a quiet line with the running version and the commit it was built from. */
export function AboutSection() {
  const { data } = useHealth();
  const commit = data && data.commit !== 'unknown' ? data.commit.slice(0, 7) : null;
  return (
    <section className="card" aria-labelledby="about-title">
      <div className="card-head">
        <h2 className="card-title" id="about-title">
          About
        </h2>
      </div>
      <Text size="sm" c="dimmed" className="wrap-anywhere">
        {data ? (
          <>
            Sparrow {data.version}
            {commit && (
              <>
                {' · commit '}
                <span className="mono">{commit}</span>
              </>
            )}
          </>
        ) : (
          '...'
        )}
      </Text>
    </section>
  );
}
