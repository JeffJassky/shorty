/** Server `error` code → sentence (spec §5). */
const MESSAGES: Record<string, string> = {
  invalid_url: "That doesn't look like a web address.",
  unsupported_scheme: 'Only http and https links can be shortened.',
  host_not_allowed: "Links to this site aren't allowed here.",
  host_blocked: 'Links to this site are blocked.',
  destination_loop: "A short link can't point to another short link on this site.",
  slug_invalid: 'Use letters, numbers, - and _ (and / between words).',
  slug_too_long: "That's too long — 190 characters max.",
  slug_reserved: 'That ending is reserved.',
  slug_taken: 'That ending is already in use.',
  slug_locked: "This short link can't be renamed.",
  validation: 'Something in the form needs fixing.',
  not_found: 'This link no longer exists.',
};

export const GENERIC_ERROR = 'Something went wrong. Try again.';

export function messageForCode(code: string | undefined): string {
  return (code && MESSAGES[code]) || GENERIC_ERROR;
}

/** The `error` code from an ApiError payload or a thrown ShortyError. */
export function errorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const payload = (err as { payload?: unknown }).payload;
  if (payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string') {
    return (payload as { error: string }).error;
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** `details.field` of a `validation` error, when the server names one. */
export function errorField(err: unknown): string | undefined {
  const payload = err && typeof err === 'object' ? (err as { payload?: unknown }).payload : undefined;
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as { field?: unknown; details?: { field?: unknown } };
  const field = p.details?.field ?? p.field;
  return typeof field === 'string' ? field : undefined;
}

export const errorMessage = (err: unknown): string => messageForCode(errorCode(err));

export const SLUG_CODES = new Set(['slug_invalid', 'slug_too_long', 'slug_reserved', 'slug_taken', 'slug_locked']);
export const DESTINATION_CODES = new Set([
  'invalid_url', 'unsupported_scheme', 'host_not_allowed', 'host_blocked', 'destination_loop',
]);

export const SLUG_REASON_CODE = {
  invalid: 'slug_invalid',
  too_long: 'slug_too_long',
  reserved: 'slug_reserved',
  taken: 'slug_taken',
} as const;
