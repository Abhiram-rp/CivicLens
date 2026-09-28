import type { ApiRequestInterceptor } from '../api/interceptor-types';
import { apiPath } from '../api/api-base-url';
import { TrackingTokenStore } from './tracking-token.store';

/**
 * Attaches the concealed-report tracking token to `/tracked/**` requests.
 *
 * Header, not query parameter, for the reason the contract gives: a value in
 * the query string ends up in access logs, proxy logs, and `Referer` headers
 * on any outbound link. The same reasoning is why the token never appears in a
 * route in this application - see `TrackingTokenStore`.
 *
 * Attached only for the tracked tree, and only when a token is held. Sending it
 * anywhere else would widen the blast radius of a leaked token from "one
 * report" to "whatever the reporter was doing", so the path check is the
 * security control here, not an optimisation.
 *
 * The check goes through `apiPath`, not `pathname`: a `Request.url` carries the
 * `/api/v1` base prefix, so a plain `startsWith('/tracked/')` never matched any
 * real request and the token was silently never sent. The failure mode is a
 * silent 403 for a reporter who has done everything right, which is why the
 * header's presence is asserted directly in `mock/handlers.spec.ts`.
 *
 * The store arrives as a parameter rather than through `inject()`, because the
 * generated client calls this with no injection context. See the note in
 * `auth.interceptor.ts`, which is the same bug and the same fix.
 */
export function createTrackingTokenInterceptor(store: TrackingTokenStore): ApiRequestInterceptor {
  return (request) => {
    if (!apiPath(request.url).startsWith('/tracked/')) {
      return request;
    }

    const token = store.current();
    if (token) {
      request.headers.set('X-Tracking-Token', token);
    }
    return request;
  };
}
