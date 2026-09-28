import type { ApiRequestInterceptor } from '../api/interceptor-types';
import { AuthService } from './auth.service';
import { isSessionExempt } from '../api/session-policy';

/**
 * Attaches the session bearer to requests that require one.
 *
 * ## Why the service is a parameter and not an `inject()` call
 *
 * The generated client invokes an interceptor as a plain function, at request
 * time, with no injection context around it. An `inject()` call there throws
 * `NG0203` on the first request and every request after it. This is not a
 * theoretical hazard: it is what shipped, and it was invisible because the tests
 * wrapped these functions in `TestBed.runInInjectionContext`, which manufactures
 * the very context the browser will not provide.
 *
 * So the dependency is resolved once, at registration, and closed over. The
 * interceptor body is now a pure function of `(request, token)` with no Angular
 * in it at all, which is also why it needs no `TestBed` to test.
 *
 * The token is read per request rather than captured once, so a refresh that
 * lands mid-session takes effect on the very next call without any component
 * having to re-trigger anything. Resolving `AuthService` once is not the same as
 * caching the token.
 *
 * Withholding is as important as attaching, and is the reason
 * `isSessionExempt` exists: on `/tracked/**`, `/contact/**` and `/public/**` a
 * session token must never ride along. See `session-policy.ts` for why that
 * separation is structural rather than cosmetic.
 */
export function createAuthInterceptor(auth: AuthService): ApiRequestInterceptor {
  return (request) => {
    const token = auth.accessToken;

    if (!token || isSessionExempt(request.url)) {
      return request;
    }

    // Set in place rather than via `new Request(request, { headers })`. Both work
    // for a header this request is allowed to carry, but the constructor form
    // transfers the body stream out of the original request, and every mutation
    // in this chain would then have to know about that. Setting on the existing
    // `Headers` is guard-checked by the platform: `Authorization` is allowed, a
    // forbidden name would throw rather than silently leak.
    request.headers.set('Authorization', `Bearer ${token}`);
    return request;
  };
}
