import { useEffect, useRef, useState } from 'react';
import { EXPORT_FORMAT, EXPORT_SCHEMA_VERSION } from '@sparrow/shared';
import { Alert, Button, Group, Modal, Text } from '@mantine/core';
import { useDrives, useLayout } from '../api/hooks';
import { useConfig, useImport, type ImportResult } from '../api/settings';
import { ApiErrorAlert } from './ApiErrorAlert';

interface FileCounts {
  drives: number;
  enclosures: number;
  grids: number;
  slots: number;
  pools: number;
  activities: number;
}

const COUNT_LABELS: [keyof FileCounts, string][] = [
  ['drives', 'drives'],
  ['enclosures', 'enclosures'],
  ['grids', 'grids'],
  ['slots', 'slots'],
  ['pools', 'pools'],
  ['activities', 'activities'],
];

const plural = (n: number, word: string) =>
  `${n} ${n === 1 && word.endsWith('s') ? word.slice(0, -1) : word}`;
const describe = (c: FileCounts) => COUNT_LABELS.map(([k, w]) => plural(c[k], w)).join(', ');

/** Counts the arrays in a parsed export file; anything unexpected counts as 0 and the server decides. */
function countsOf(file: unknown): FileCounts {
  const data =
    typeof file === 'object' && file !== null && 'data' in file
      ? (file as { data: unknown }).data
      : null;
  const n = (key: string) => {
    const v =
      typeof data === 'object' && data !== null ? (data as Record<string, unknown>)[key] : null;
    return Array.isArray(v) ? v.length : 0;
  };
  return {
    drives: n('drives'),
    enclosures: n('enclosures'),
    grids: n('grids'),
    slots: n('slots'),
    pools: n('pools'),
    activities: n('activities'),
  };
}

/**
 * R43: checks the file's marker and schema version before the confirm step, so a file the server will
 * refuse never reaches "Replace all data". The server still validates everything.
 */
export function exportFileProblem(file: unknown, name: string): string | null {
  const o = typeof file === 'object' && file !== null ? (file as Record<string, unknown>) : null;
  if (!o || o.format !== EXPORT_FORMAT) {
    return `${name} is not a Sparrow export file.`;
  }
  const v = o.schemaVersion;
  if (typeof v !== 'number') return `${name} has no export version, so it cannot be imported.`;
  if (v > EXPORT_SCHEMA_VERSION) {
    return `${name} was made by a newer Sparrow (export version ${v}); this one imports version ${EXPORT_SCHEMA_VERSION}. Update Sparrow first.`;
  }
  if (v < EXPORT_SCHEMA_VERSION) {
    return `${name} is an old export (version ${v}) from a pre-release build; this Sparrow imports version ${EXPORT_SCHEMA_VERSION} only.`;
  }
  return null;
}

/** Settings > Backup: export download, and import with a required confirmation (R41, R43, R44). */
export function BackupSection() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<{ name: string; json: unknown } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const config = useConfig();
  const layout = useLayout();
  const drives = useDrives();
  const doImport = useImport();
  // The result sits above the buttons; on a phone make sure it is on screen after the dialog closes.
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (result) resultRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [result]);

  const current: FileCounts | null =
    layout.data && drives.data
      ? {
          drives: drives.data.length,
          enclosures: layout.data.enclosures.length,
          grids: layout.data.enclosures.reduce((n, e) => n + e.grids.length, 0),
          slots: layout.data.enclosures.reduce(
            (n, e) => n + e.grids.reduce((m, g) => m + g.slots.length, 0),
            0,
          ),
          pools: 0,
          activities: 0,
        }
      : null;

  const onPick = async (file: File | undefined) => {
    setResult(null);
    setFileError(null);
    doImport.reset();
    if (!file) return;
    try {
      const json: unknown = JSON.parse(await file.text());
      const problem = exportFileProblem(json, file.name);
      if (problem) {
        setParsed(null);
        setFileError(problem);
      } else {
        setParsed({ name: file.name, json });
      }
    } catch {
      setParsed(null);
      setFileError(`${file.name} is not valid JSON, so it cannot be a Sparrow export.`);
    }
    if (fileInput.current) fileInput.current.value = '';
  };

  const close = () => {
    setParsed(null);
    doImport.reset();
  };

  const confirm = () => {
    if (!parsed) return;
    doImport.mutate(parsed.json, {
      onSuccess: (res) => {
        setResult(res);
        setParsed(null);
      },
    });
  };

  return (
    <section className="card" aria-labelledby="backup-title">
      <div className="card-head">
        <h2 className="card-title" id="backup-title">
          Backup
        </h2>
      </div>
      {fileError ? (
        <Alert color="red" title="Cannot read that file" role="alert" mb="md">
          {fileError}
        </Alert>
      ) : null}
      {result ? (
        <Alert color="green" title="Import complete" mb="md" role="status" ref={resultRef}>
          <p style={{ margin: 0 }}>
            Imported{' '}
            {['drives', 'enclosures', 'grids', 'slots', 'pools', 'events']
              .map((k) => plural(result.counts[k] ?? 0, k))
              .join(', ')}
            .
          </p>
          <p style={{ margin: '4px 0 0' }}>
            Your previous data was saved first to{' '}
            <span className="mono wrap-anywhere">{result.backupPath}</span>.
          </p>
        </Alert>
      ) : null}

      <Text size="sm" c="dimmed" mb="md">
        Export saves everything Sparrow knows (layout, drives, pools and history) as one JSON file.
        Import replaces all current data with the contents of such a file.
      </Text>
      <Group>
        <Button component="a" href="/api/export" download variant="light">
          Export data
        </Button>
        <Button variant="default" onClick={() => fileInput.current?.click()}>
          Import from file
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          aria-label="Import file"
          hidden
          data-testid="import-file"
          onChange={(e) => void onPick(e.target.files?.[0])}
        />
      </Group>
      <Modal opened={parsed !== null} onClose={close} title="Replace all data with this file?">
        {parsed ? (
          <>
            <Text>
              Importing <strong>{parsed.name}</strong> will replace{' '}
              <strong>all current data</strong>
              {current
                ? ` (${plural(current.drives, 'drives')}, ${plural(current.enclosures, 'enclosures')}, ${plural(current.grids, 'grids')})`
                : ''}{' '}
              with the file&apos;s contents: {describe(countsOf(parsed.json))}.
            </Text>
            <Text mt="sm">
              Before replacing anything, Sparrow saves the current data as a backup file in{' '}
              <span className="mono wrap-anywhere">
                {config.data?.backupDir ?? 'the exports folder'}
              </span>
              .
            </Text>
            <ApiErrorAlert error={doImport.error} title="Import failed" />
            <Group mt="md" justify="flex-end">
              <Button variant="default" onClick={close}>
                Cancel
              </Button>
              <Button color="red" loading={doImport.isPending} onClick={confirm}>
                Replace all data
              </Button>
            </Group>
          </>
        ) : null}
      </Modal>
    </section>
  );
}
