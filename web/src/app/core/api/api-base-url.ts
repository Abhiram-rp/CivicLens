/**
 * The API root.
 *
 * Must match the first entry of `servers` in the contract. It lives in its own
 * module rather than in `api-client.config.ts` because both the interceptors and
 * `session-policy.ts` need it, and importing it from the client config would
 * make that config import the interceptors that import it - a cycle that works
 * only until the first test imports something in the wrong order.
 *
 * It is duplicated from the contract because the generated client bakes its own
 * `baseUrl` into `client.gen.ts`, and a hand-edited constant that disagreed with
 * the contract would send requests to a host nobody is testing against - a
 * failure with no error message, just a 404 from the wrong port.
 * `scripts/check-generated-api.mjs` asserts the two agree, so it cannot drift.
 *
 * Two servers are declared in the contract: `http://localhost:8080/api/v1` for
 * development and `https://civiclens.example.org/api/v1` for production. Only
 * the first is used at build time; deployment rewrites it.
 */
export const API_BASE_URL = 'http://localhost:8080/api/v1';

/** The base URL's path prefix, without a trailing slash: `/api/v1`. */
const BASE_PATH = new URL(API_BASE_URL).pathname.replace(/\/+$/, '');

/**
 * The path a request URL has *relative to the API root*.
 *
 * This exists because the credential rules are stated in terms of contract
 * paths - `/tracked/**`, `/public/**`, `/auth/**` - while a `Request.url` is
 * absolute and carries the base URL's `/api/v1` prefix in front of them. Testing
 * a real request URL for a leading `/tracked/` therefore always fails, and
 * testing its first path segment always returns `api`.
 *
 * That was not hypothetical: the first version of `isSessionExempt` segmented
 * the raw pathname, so `http://localhost:8080/api/v1/auth/login` was treated as
 * segment `/api`, no path was ever exempt, and `authInterceptor` attached a
 * session bearer to `/auth/**`, `/tracked/**` and `/public/**` - precisely the
 * leak the function exists to prevent. The unit tests passed throughout, because
 * they called it with bare paths. Only a test that used real client URLs
 * surfaced it.
 *
 * Stripping the known base prefix - rather than, say, matching any segment
 * anywhere - keeps the rule exact. A URL outside the API root is returned
 * unchanged, so it fails to match an exempt tree and gets the bearer, which is
 * the safe direction to be wrong in.
 */
export function apiPath(url: string): string {
  const { pathname } = new URL(url, 'http://placeholder.invalid');
  if (!pathname.startsWith(BASE_PATH)) {
    return pathname;
  }
  const relative = pathname.slice(BASE_PATH.length);
  return relative === '' ? '/' : relative;
}
