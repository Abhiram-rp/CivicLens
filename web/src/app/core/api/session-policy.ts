/**
 * How the generated client is wired, and the two rules the contract cannot
 * express through generated code.
 *
 * ## Why the frontend attaches the bearer at all
 *
 * SPEC 7.1 makes `Authorization: Bearer` the session credential, and SPEC 7.2a
 * makes reporter identity on `/tracked/**` structurally absent. Both are
 * enforced client-side, in `AuthInterceptor`, rather than by the generated SDK.
 *
 * That is not a preference. The generator drops `security` from the emitted
 * data entirely - no operation carries a `security` field - so the SDK's own
 * `setAuthParams` branch never runs and no request would ever receive a bearer
 * token. The contract's 15 `security: []` markers are also erased on the way
 * through, because "no security" and "inherits the global bearer" produce
 * identical output.
 *
 * So the separation the spec is careful about has to be re-established by hand
 * from the URL. `SESSION_EXEMPT_PATHS` is that hand-written rule, and
 * `session-policy.spec.ts` cross-checks it against the contract so the two
 * cannot quietly disagree.
 */

import { apiPath } from './api-base-url';

/**
 * Paths that must never receive a session bearer token.
 *
 * Each entry is a deliberate decision, not a tidy-up:
 *
 * - `/auth/**` - login and refresh must not present a stale or expired token.
 *   Refresh authenticates with the HttpOnly cookie; a bearer alongside it can
 *   only confuse the server's own view of who is calling.
 * - `/tracked/**` - the concealed reporter's tree. A session token here would
 *   blur the exact property SPEC 7.2a protects: that reporter identity is
 *   *structurally* absent, not merely unused. A tracking token identifies one
 *   report; a session token identifies a person. Attaching both would make the
 *   separation a convention instead of a fact.
 * - `/contact/**` - the approval gate, reached from an emailed link that is
 *   often opened on a different device by a different browser session. Its
 *   credential is the single-use token in the link and nothing else.
 * - `/public/**` - public by definition; a session must not be able to change
 *   what an anonymous visitor sees.
 */
export const SESSION_EXEMPT_PATHS: readonly string[] = ['/auth', '/tracked', '/contact', '/public'];

/**
 * The one path family deliberately absent from `SESSION_EXEMPT_PATHS`: `/issues`.
 *
 * The contract marks `POST /issues` `security: []` because it is the endpoint
 * where concealment is chosen at runtime, and OpenAPI cannot express "bearer
 * optional". The server reads the header's presence as the answer: a valid
 * `Authorization` means a signed-in CITIZEN is the reporter, and no header
 * means the report is concealed and the tracking token in the 201 body is the
 * reporter's handle.
 *
 * So the interceptor attaches the bearer when a session exists and omits it
 * entirely when it does not, and that omission *is* the concealed path.
 * Getting this backwards in either direction is a real defect: never attaching
 * it files a signed-in citizen's report as concealed, and always attaching it
 * sends a session token on a request that must stay anonymous.
 */

/** Path portion of an API path, e.g. `/tracked/issues/abc` -> `/tracked`. */
function firstSegment(path: string): string {
  const [, rest = ''] = path.split('/', 2);
  return `/${rest.split('/')[0]}`;
}

/**
 * Whether a session bearer must be withheld for this URL.
 *
 * Segment-based on purpose: `SESSION_EXEMPT_PATHS` is a set of trees, and
 * matching the tree rather than individual endpoints is what keeps a newly
 * added `/tracked/...` endpoint exempt by default. Opting in would mean a
 * forgotten endpoint silently started sending session tokens to a surface
 * whose entire purpose is that reporter identity is absent.
 *
 * Takes a full request URL and resolves it through `apiPath` first. Passing the
 * raw pathname here was the bug documented in `api-base-url.ts`: with the
 * `/api/v1` base prefix still attached, the first segment of every request was
 * `api`, so nothing was ever exempt.
 */
export function isSessionExempt(url: string): boolean {
  return SESSION_EXEMPT_PATHS.includes(firstSegment(apiPath(url)));
}
