import { useState } from 'react';
import { Button, Checkbox } from '@mantine/core';
import type { Drive, Suggestion, SuggestionField } from '@sparrow/shared';
import { useApplySuggestions, useDismissSuggestions } from '../api/driveMutations';
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
  const dismiss = useDismissSuggestions(drive.id, 'dismiss');
  const undismiss = useDismissSuggestions(drive.id, 'undismiss');
  const provider = useProviderStatus().data?.providerId;
  const apply = useApplySuggestions(drive.id);
  // Fields the owner ticked or unticked; untouched rows default to ticked for "fill", not for "differs".
  const [picked, setPicked] = useState<Partial<Record<SuggestionField, boolean>>>({});
  const [showDiffers, setShowDiffers] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);

  const all = suggestions.data?.suggestions ?? [];
  const dismissed = suggestions.data?.dismissed ?? [];
  if (all.length === 0 && dismissed.length === 0) return null;
  const name = provider && provider !== 'none' ? providerName(provider) : 'The provider';
  const fill = all.filter(isFill);
  const differs = all.filter((s) => !isFill(s));
  const checked = (s: Suggestion) => picked[s.field] ?? s.kind === 'fill';
  const chosen = all.filter((s) => (s.kind === 'differs' && !showDiffers ? false : checked(s)));

  const values = (s: Suggestion) => (
    <span className="suggestion-values">
      <span className="dim">{formatSuggestionValue(s.field, s.current)}</span>
      <span aria-hidden="true"> → </span>
      <span className="sr-only"> becomes </span>
      <span className="mono">{formatSuggestionValue(s.field, s.suggested)}</span>
    </span>
  );

  const row = (s: Suggestion) => (
    <li key={s.field} className="suggestion-item">
      <Checkbox
        checked={checked(s)}
        onChange={(e) => setPicked({ ...picked, [s.field]: e.currentTarget.checked })}
        label={
          <span className="suggestion-row">
            <strong>{FIELD_LABEL[s.field]}</strong>
            {values(s)}
          </span>
        }
      />
      <button
        type="button"
        className="link-button"
        aria-label={`Dismiss ${FIELD_LABEL[s.field].toLowerCase()} suggestion`}
        disabled={dismiss.isPending}
        onClick={() => dismiss.mutate({ fields: [s.field] })}
      >
        Dismiss
      </button>
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
        <div className="suggestion-actions">
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
          <Button
            size="compact-md"
            variant="subtle"
            disabled={chosen.length === 0}
            loading={dismiss.isPending}
            onClick={() => dismiss.mutate({ fields: chosen.map((s) => s.field) })}
          >
            Dismiss selected
          </Button>
        </div>
      ) : null}
      {apply.isError ? <ApiErrorAlert error={apply.error} title="Could not apply" /> : null}
      {dismiss.isError ? <ApiErrorAlert error={dismiss.error} title="Could not dismiss" /> : null}
      {dismissed.length > 0 ? (
        <>
          <button
            type="button"
            className="link-button suggestion-toggle"
            aria-expanded={showDismissed}
            onClick={() => setShowDismissed((v) => !v)}
          >
            {dismissed.length} dismissed — {showDismissed ? 'hide' : 'show'}
          </button>
          {showDismissed ? (
            <ul className="plain-list suggestion-list" aria-label="Dismissed suggestions">
              {dismissed.map((s) => (
                <li key={s.field} className="suggestion-item">
                  <span className="suggestion-row">
                    <strong>{FIELD_LABEL[s.field]}</strong>
                    {values(s)}
                  </span>
                  <button
                    type="button"
                    className="link-button"
                    aria-label={`Undo dismissing ${FIELD_LABEL[s.field].toLowerCase()} suggestion`}
                    disabled={undismiss.isPending}
                    onClick={() => undismiss.mutate({ fields: [s.field] })}
                  >
                    Undo
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {undismiss.isError ? (
            <ApiErrorAlert error={undismiss.error} title="Could not undo" />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
