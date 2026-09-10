/**
 * Shared HTTP error carrying an exact status + JSON payload, so handlers and the
 * SSRF/validation guards can raise FastAPI-style errors (`{"detail": ...}`,
 * `{"error": ...}`) that the server renders verbatim.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
  ) {
    super('HTTP error');
    this.name = 'HttpError';
  }
}
