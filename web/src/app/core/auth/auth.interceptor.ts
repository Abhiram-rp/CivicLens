import { inject } from '@angular/core';
import type { ApiRequestInterceptor } from '../api/interceptor-types';
import { AuthService } from './auth.service';
import { isSessionExempt } from '../api/session-policy';

/**
 * Attaches the session bearer to requests that require one.
 *
 * The token is read per request rather than captured once, so a refresh that
 * lands mid-session takes effect on the very next call without any component
 * having to re-trigger anything.
 *
 * Withholding is as important as attaching, and is the reason
 * `isSessionExempt` exists: on `/tracked/**`, `/contact/**` and `/public/**` a
 * session token must never ride along. See `session-policy.ts` for why that
 * separation is structural rather than cosmetic.
 */
export const authInterceptor: ApiRequestInterceptor = (request) => {
  const token = inject(AuthService).accessToken;

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
