import type { ShortyErrorCode } from '../../types/index.js';

/**
 * HTTP status per error code. One table: the routes answer with it, the tests
 * assert against it, and `ShortyError` defaults to it.
 */
export const ERROR_STATUS: Readonly<Record<ShortyErrorCode, number>> = Object.freeze({
  invalid_url: 400,
  unsupported_scheme: 400,
  invalid_base_url: 400,
  invalid_param: 400,
  ambiguous_destination: 400,
  slug_invalid: 400,
  slug_too_long: 400,
  slug_reserved: 400,
  validation: 400,
  range_too_large: 400,
  not_found: 404,
  slug_taken: 409,
  slug_locked: 409,
  host_not_allowed: 422,
  host_blocked: 422,
  destination_loop: 422,
  slug_generation_exhausted: 500,
  case_collision: 500,
});

/**
 * Every failure the caller caused, as itself. The programmatic API throws it;
 * the routes answer `{ error: code, ...details }` with `status`.
 *
 * Lives in `shared/` because `parseUrl` / `composeUrl` throw it and the SPA
 * imports those.
 */
export class ShortyError extends Error {
  code: ShortyErrorCode;

  status: number;

  details?: Record<string, unknown>;

  constructor(code: ShortyErrorCode, status?: number, details?: Record<string, unknown>) {
    super(code);
    this.name = 'ShortyError';
    this.code = code;
    this.status = status ?? ERROR_STATUS[code];
    this.details = details;
  }
}
