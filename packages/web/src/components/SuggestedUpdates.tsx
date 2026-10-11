import { useState } from 'react';
import { Button, Checkbox } from '@mantine/core';
import type { Drive, Suggestion, SuggestionField } from '@sparrow/shared';
import { useApplySuggestions } from '../api/driveMutations';
import { useDriveSuggestions, useProviderStatus } from '../api/hooks';
import { FIELD_LABEL, formatSuggestionValue, isFill } from '../lib/suggestions';
import { ApiErrorAlert } from './ApiErrorAlert';
import { providerName } from './ProviderStatusLine';

/**
 * R72: details the provider reports for this (matched) drive that the record lacks ("fill") or
 * disagrees about ("differs"). Nothing is applied until the owner ticks fields and confirms.
 */
export function SuggestedUpdates({ drive }: { drive: Drive }) {
  const suggestions = useDriveSuggestions(drive.id);
  const provider = useProviderStatus().data?.providerId;
  const apply = useApplySuggestions(drive.id);
  // Fields the owner ticked or unticked; untouched rows default to ticked for "fill", not for "differs".
  const [picked, setPicked] = useState<Partial<Record<SuggestionField, boolean>>>({});
  const [showDiffers, setShowDiffers] = useState(false);

  const all = suggestions.data ?? [];
  if (all.length === 0) return null;
  const name = provider && provider !== 'none' ? providerName(provider) : 'The provider';
  const fill = all.filter(isFill);
  const differs = all.filter((s) => !isFill(s));
  const checked = (s: Suggestion) => picked[s.field] ?? s.kind === 'fill';
  const chosen = all.filter((s) => (s.kind === 'differs' && !showDiffers ? false : checked(s)));

  const row = (s: Suggestion) => (
    <li key={s.field}>
      <Checkbox
        checked={checked(s)}
        onChange={(e) => setPicked({ ...picked, [s.field]: e.currentTarget.checked })}
        label={
          <span className="suggestion-row">
            <strong>{FIELD_LABEL[s.field]}</strong>
            <span className="suggestion-values">
              <span className="dim">{formatSuggestionValue(s.field, s.current)}</span>
              <span aria-hidden="true"> → </span>
              <span className="sr-only"> becomes </span>
              <span className="mono">{formatSuggestionValue(s.field, s.suggested)}</span>
            </span>
          </span>
        }
      />
    </li>
  );

  return (
    <section className="suggested-updates" aria-label="Suggested updates">
      {fill.length > 0 ? (
        <>
          <h3 className="suggestion-title">{name} reports details this record doesn&apos;t have</h3>
          <ul className="plain-list suggestion-list">{fill.map(row)}</ul>
        </>
      ) : null}
      {differs.length > 0 ? (
        <>
          <button
            type="button"
            className="link-button suggestion-toggle"
            aria-expanded={showDiffers}
            onClick={() => setShowDiffers((v) => !v)}
          >
            {name} reports different values ({differs.length})
          </button>
          {showDiffers ? <ul className="plain-list suggestion-list">{differs.map(row)}</ul> : null}
        </>
      ) : null}
      {fill.length > 0 || showDiffers ? (
        <Button
          size="compact-md"
          disabled={chosen.length === 0}
          loading={apply.isPending}
          onClick={() => {
            apply.mutate(
              { fields: chosen.map((s) => s.field) },
              { onSuccess: () => setPicked({}) },
            );
          }}
        >
          Apply selected
        </Button>
      ) : null}
      {apply.isError ? <ApiErrorAlert error={apply.error} title="Could not apply" /> : null}
    </section>
  );
}
