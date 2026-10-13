/**
 * A URL that is safe to write to a log: userinfo (user:password@), query and fragment are dropped
 * because any of them may carry credentials. Anything that is not a URL yields undefined.
 */
export function safeUrlForLog(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const u = new URL(value);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

/** The reason behind an error: its message plus the underlying cause (fetch hides it there). */
export function errorReason(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  const detail =
    cause instanceof Error
      ? (((cause as NodeJS.ErrnoException).code ?? '') + ' ' + cause.message).trim()
      : '';
  return detail && !err.message.includes(detail) ? `${err.message} (${detail})` : err.message;
}
