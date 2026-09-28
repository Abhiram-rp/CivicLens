import type { ResolvedRequestOptions } from '../../api/generated/client';

/**
 * The shape the generated SDK expects for a request or response interceptor.
 *
 * ## Why these are not Angular `HttpInterceptorFn`s
 *
 * SPEC 14 names an `AuthInterceptor` and a `CorrelationIdInterceptor`. Both
 * exist, as `core/auth/auth.interceptor.ts` and
 * `core/auth/correlation-id.interceptor.ts`, but they are registered on the
 * generated client's own `interceptors.request.fns` /
 * `interceptors.response.fns` pipeline instead of on Angular's `HTTP_INTERCEPTORS`.
 *
 * The reason is mechanical, not stylistic. The generated SDK issues every
 * request through `fetch` - see `api/generated/client/client.gen.ts`, where
 * `request` builds a `Request` and calls `opts.fetch`. Angular's `HttpClient`
 * is not in that path at all, so an `HttpInterceptorFn` would never fire. It
 * would sit in `app.config.ts` looking like the security boundary it is not.
 *
 * A second consequence worth stating, because it is easy to miss: the generator
 * emits no `security` field on any operation, so the SDK's own
 * `setAuthParams` branch never runs. Nothing attaches a bearer token unless
 * `authInterceptor` does.
 */
export type ApiRequestInterceptor = (
  request: Request,
  options: ResolvedRequestOptions,
) => Request | Promise<Request>;

export type ApiResponseInterceptor = (
  response: Response,
  request: Request,
  options: ResolvedRequestOptions,
) => Response | Promise<Response>;

/** True when a request body must survive the interceptor chain untouched. */
export function hasBody(request: Request): boolean {
  return request.body !== null;
}
