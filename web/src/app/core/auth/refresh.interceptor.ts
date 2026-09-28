import { inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { ApiRequestInterceptor, ApiResponseInterceptor } from '../api/interceptor-types';
import { AuthService } from './auth.service';

/**
 * Transparent single-refresh on 401 (SPEC 14).
 *
 * Three properties matter here, and all three are about not making things worse
 * when the network is already unhappy:
 *
 * 1. **Once.** The original request is retried at most one time, marked by a
 *    private header. Without that, a request that keeps returning 401 - because
 *    the account was disabled, say - would refresh and retry forever.
 *
 * 2. **Once across the app, not once per request.** A dashboard fires several
 *    calls at once; if four of them 401 at the same moment, four independent
 *    refreshes would be issued. SPEC 7.1 rotates the refresh token on every use
 *    and treats a replay of an already-revoked token as theft, revoking the
 *    whole family. A refresh storm would therefore sign the user out and look
 *    like an account compromise. The in-flight promise below is what prevents
 *    that: the first caller starts the refresh, the rest await the same one.
 *
 * 3. **Not for the refresh call itself.** A 401 from `/auth/refresh` must not
 *    trigger another refresh.
 */
const RETRY_MARKER = 'X-CivicLens-Retried';

/** Path suffix of the refresh endpoint, per the contract. */
const REFRESH_PATH = '/auth/refresh';

/** Injected, so tests can drive it without a real network. */
let inFlightRefresh: Promise<string> | null = null;

/**
 * Reset the shared refresh promise. Test-only.
 *
 * Without this a test that exercises a successful refresh leaves a resolved
 * promise in module state, and the next test in the same worker silently reuses
 * a stale token instead of refreshing.
 */
export function resetRefreshStateForTest(): void {
  inFlightRefresh = null;
}

/**
 * Refreshes the session, collapsing concurrent callers onto one request.
 *
 * `AuthService.refresh` is an Observable and this is a promise-based pipeline,
 * so the conversion is explicit rather than hidden in a `toPromise()`, which is
 * gone from RxJS and would have to be written out anyway.
 */
async function refreshOnce(auth: AuthService): Promise<string> {
  inFlightRefresh ??= firstValueFrom(auth.refresh()).finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

/**
 * Marks requests that must not trigger a refresh: the auth endpoints, and
 * anything already retried once.
 */
function isRefreshCandidate(request: Request): boolean {
  if (request.headers.has(RETRY_MARKER)) {
    return false;
  }
  const { pathname } = new URL(request.url, 'http://placeholder.invalid');
  return !pathname.endsWith(REFRESH_PATH) && !pathname.endsWith('/auth/login');
}

/**
 * Response interceptor: on 401, refresh once and replay the request.
 *
 * Returns the retried `Response` so the SDK's own success/error handling sees a
 * normal outcome and nothing downstream needs to know a retry happened.
 */
export const refreshInterceptor: ApiResponseInterceptor = async (response, request) => {
  if (response.status !== 401 || !isRefreshCandidate(request)) {
    return response;
  }

  const auth = inject(AuthService);

  let accessToken: string;
  try {
    accessToken = await refreshOnce(auth);
  } catch {
    // The refresh itself was rejected: the cookie is gone, expired or revoked.
    // Nothing further to try, and retrying would loop. The local session is
    // dropped so the guard sends the citizen to sign in rather than leaving them
    // on a page that will keep failing.
    auth.clearSession();
    return response;
  }

  const replayed = new Request(request.url, {
    method: request.method,
    headers: new Headers(request.headers),
    // A consumed body cannot be replayed, so a retried upload is reported
    // honestly rather than sent with a truncated body.
    body: request.bodyUsed ? null : request.body,
    // `redirect` and `mode` are deliberately not copied: the SDK sets them, and
    // a `Request` built without them defaults differently from the original.
  });
  replayed.headers.set('Authorization', `Bearer ${accessToken}`);
  replayed.headers.set(RETRY_MARKER, '1');

  return fetch(replayed);
};
