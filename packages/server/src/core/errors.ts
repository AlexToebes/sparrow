/** Error kinds the API maps to HTTP status codes (see api/app.ts). */
export type DomainErrorCode = 'not-found' | 'conflict' | 'invalid';

/**
 * A rule or lookup failure raised by core services. The HTTP layer maps `code`
 * to 404, 409 or 400. `details` is optional structured context for the client.
 */
export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details?: unknown;

  constructor(code: DomainErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const notFound = (msg: string): DomainError => new DomainError('not-found', msg);
export const conflict = (msg: string, details?: unknown): DomainError =>
  new DomainError('conflict', msg, details);
export const invalid = (msg: string, details?: unknown): DomainError =>
  new DomainError('invalid', msg, details);
