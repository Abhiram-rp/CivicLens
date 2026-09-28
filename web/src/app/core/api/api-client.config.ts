import { client } from '../../api/generated/client.gen';
import { API_BASE_URL } from './api-base-url';
import { authInterceptor } from '../auth/auth.interceptor';
import { correlationIdInterceptor } from '../auth/correlation-id.interceptor';
import { refreshInterceptor } from '../auth/refresh.interceptor';
import { trackingTokenInterceptor } from '../tracking/tracking-token.interceptor';

// Re-exported so existing importers keep one obvious place to look, while the
// literal itself lives in `api-base-url.ts` where `apiPath` can read it without
// importing this file - and therefore without a cycle through the interceptors.
export { API_BASE_URL };

/** Ids returned by `use()`, paired with the chain that owns them. */
type Chain = {
  eject: (id: number) => void;
};

const registered: Array<{ chain: Chain; id: number }> = [];

/**
 * Register the interceptor chain on the generated client.
 *
 * Order is registration order and is not arbitrary:
 *
 *   1. `trackingTokenInterceptor` - the tracking token is a distinct credential
 *      on a distinct tree, and keeping it first holds that separate from
 *      anything to do with the session.
 *   2. `authInterceptor` - the session bearer, withheld on exempt paths.
 *   3. `refreshInterceptor` - runs on the response, after 1 and 2 have shaped
 *      the outgoing request, so the retry it issues reuses the same rules
 *      instead of reimplementing them.
 *   4. `correlationIdInterceptor` - reads the error envelope, so it runs last
 *      and sees the final response, including a successful retry.
 */
export function configureApiClient(): void {
  if (registered.length > 0) {
    return;
  }

  client.setConfig({
    baseUrl: API_BASE_URL,

    // Required for the refresh cookie. SPEC 7.1 delivers the WEB refresh token
    // as HttpOnly SameSite=Strict, so it is only sent if the request opts into
    // credentials. Without this the session would silently expire every fifteen
    // minutes while looking perfectly healthy.
    credentials: 'include',

    // Make a failed request reject with the server's `ErrorEnvelope` rather than
    // resolving to a `{ error }` record that all 56 call sites would have to
    // remember to check. One forgotten check is an error rendered as an empty
    // page, so the failure mode belongs in the transport.
    //
    // Note this does not change the generated *types*, which stay frozen at
    // `throwOnError: false`. `unwrap` in `api-call.ts` reconciles the two.
    throwOnError: true,
  });

  const { request: requestChain, response: responseChain } = client.interceptors;

  registered.push(
    { chain: requestChain, id: requestChain.use(trackingTokenInterceptor) },
    { chain: requestChain, id: requestChain.use(authInterceptor) },
    { chain: responseChain, id: responseChain.use(refreshInterceptor) },
    { chain: responseChain, id: responseChain.use(correlationIdInterceptor) },
  );
}

/**
 * Remove every registered interceptor. Test-only.
 *
 * Without this a spec that calls `configureApiClient()` twice - or a second spec
 * file in the same worker - ends up with the chain installed twice, and a 401
 * would refresh twice. The double-refresh is not a harmless duplication: SPEC
 * 7.1 treats a replayed refresh token as theft and revokes the token family.
 */
export function resetApiClientForTest(): void {
  for (const { chain, id } of registered) {
    chain.eject(id);
  }
  registered.length = 0;
}
