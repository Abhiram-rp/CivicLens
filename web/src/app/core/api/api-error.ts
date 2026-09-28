import type { ErrorEnvelope } from '../../api/generated';

/**
 * The CivicLens error model (SPEC 7.4) as a type the UI can branch on.
 *
 * The server already returns a structured envelope, so this adds no new error
 * vocabulary - it exists so that a component can ask "was this a state
 * transition I should explain?" without a string comparison, and so that
 * `traceId` is a first-class field the UI can quote rather than something a
 * developer has to remember to dig out of a raw response.
 */
export type ApiErrorCode = ErrorEnvelope['code'];

/** Codes a citizen can act on, as opposed to codes that are the system's fault. */
const CITIZEN_ACTABLE: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>([
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'INVALID_STATE_TRANSITION',
  'OFFICER_NOT_IN_DEPARTMENT',
  'REOPEN_WINDOW_EXPIRED',
  'COMMENT_EDIT_WINDOW_EXPIRED',
  'DEPARTMENT_HAS_OPEN_ISSUES',
  'CATEGORY_HAS_OPEN_ISSUES',
  'RATE_LIMITED',
]);

/**
 * Whether a failed request carries a real error envelope.
 *
 * A network failure, an aborted request or a non-JSON proxy error page all
 * reach this code as a non-envelope value. `traceId` is the tell: the server
 * always sets it, so its absence means the response did not come from CivicLens
 * and any `code` we invented for it would be a guess.
 */
export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'traceId' in value &&
    typeof (value as ErrorEnvelope).traceId === 'string'
  );
}

/** The correlation id to show a citizen, or null when there is not one. */
export function traceIdOf(error: unknown): string | null {
  return isErrorEnvelope(error) ? error.traceId : null;
}

/**
 * A message safe to show a citizen.
 *
 * SPEC 7.4 requires the server's `message` to be free of PII and internals, so
 * it is used as-is when present. The fallbacks matter because the alternative -
 * showing a status code - is what makes a civic service look broken, and
 * `AI_UNAVAILABLE` is explicitly never surfaced to a citizen.
 */
export function citizenMessage(error: unknown): string {
  if (isErrorEnvelope(error)) {
    if (error.code === 'INTERNAL_ERROR') {
      return 'Something went wrong on our side. Your report is safe.';
    }
    if (error.code === 'UNAUTHENTICATED') {
      return 'Please sign in to continue.';
    }
    if (error.code === 'FORBIDDEN') {
      return 'You do not have access to that.';
    }
    if (error.code === 'RATE_LIMITED') {
      return 'Too many attempts. Please wait a moment and try again.';
    }
    if (CITIZEN_ACTABLE.has(error.code)) {
      return error.message;
    }
    // An unrecognised code is still not a reason to show raw internals.
    return 'That request could not be completed.';
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return 'That request was cancelled.';
  }
  return 'We could not reach CivicLens. Check your connection and try again.';
}

/**
 * Per-field messages for form display.
 *
 * Returns a map keyed by field name so a typed reactive form can assign straight
 * into its controls. An empty object means "the failure is not about your
 * input", which the form shows as a general error instead of marking fields.
 */
export function fieldErrorsOf(error: unknown): Record<string, string> {
  if (!isErrorEnvelope(error) || !error.details?.length) {
    return {};
  }
  const mapped: Record<string, string> = {};
  for (const detail of error.details) {
    // `field` and `issue` are both optional in the contract, so a detail that
    // carries neither is skipped rather than being written under an `undefined`
    // key, which would render as a control named "undefined".
    if (!detail.field || !detail.issue) {
      continue;
    }
    mapped[detail.field] ??= detail.issue;
  }
  return mapped;
}
