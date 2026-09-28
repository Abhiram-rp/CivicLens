import type { ApiResponseInterceptor } from '../api/interceptor-types';
import { isErrorEnvelope } from '../api/api-error';

/**
 * Surfaces `traceId` so a citizen can quote it in a support request (SPEC 14).
 *
 * The correlation id is only in the error body, so it is read here and stashed
 * where a component can reach it. It is deliberately not pushed into a global
 * error toast: the toast is the citizen's, and the trace id belongs with the
 * error that produced it, not with whatever unrelated request happened to fail
 * next.
 *
 * Reading a `Response` body consumes it, so this inspects a `clone()`. The
 * clone is only taken on an error path, where the body is small, so the copy
 * costs nothing on the happy path.
 */
export const correlationIdInterceptor: ApiResponseInterceptor = async (response) => {
  if (response.ok || !response.body) {
    return response;
  }

  try {
    const envelope = await response.clone().json();
    if (isErrorEnvelope(envelope)) {
      lastTraceId = envelope.traceId;
      lastTraceStatus = response.status;
    }
  } catch {
    // A non-JSON error body is a proxy or gateway page, not a CivicLens
    // response. There is no trace id in it, which is the honest outcome: the UI
    // then omits the reference rather than inventing one.
  }

  return response;
};

/**
 * The most recent correlation id seen this session.
 *
 * Module state rather than a service because it is diagnostic telemetry, not
 * application state: nothing branches on it, and threading a singleton through
 * DI for a value only the error panel reads would be structure without a
 * purpose. Reset by `resetTraceIdForTest`.
 */
let lastTraceId: string | null = null;
let lastTraceStatus: number | null = null;

export function lastErrorTrace(): { traceId: string; status: number } | null {
  return lastTraceId && lastTraceStatus ? { traceId: lastTraceId, status: lastTraceStatus } : null;
}

/** Test-only: clears the recorded correlation id. */
export function resetTraceIdForTest(): void {
  lastTraceId = null;
  lastTraceStatus = null;
}
