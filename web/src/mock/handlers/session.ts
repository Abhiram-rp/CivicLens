import { http, HttpResponse } from 'msw';
import type { ClientType, LoginResponse, TokenRefreshResponse } from '../../app/api/generated/types.gen';
import { API, forbidden, rejectUnexpectedBearer, unauthenticated } from '../http';
import { asCurrentUser, state, userByEmail } from '../store';

/**
 * `/auth/login`, `/auth/refresh` and `/auth/logout`.
 *
 * All three are `security: []`, so a bearer arriving on any of them is a client bug
 * and is rejected as a malformed request (400) rather than as a permission failure.
 *
 * ## Why login reads the store rather than a constant map
 *
 * The previous version answered from a fixed `ACCOUNTS` literal, which meant two
 * controls were unreachable:
 *
 * - a citizen who called `POST /auth/register` could not then log in, because the
 *   login handler had never heard of them;
 * - `DISABLED` was part of the `User` type and nothing could ever produce it, so
 *   SPEC's abuse control - soft-disable, never delete - had no observable effect
 *   anywhere in the app.
 *
 * Both are now consequences of the same row rather than two extra branches.
 */

/** The one password every seeded account accepts. */
const MOCK_PASSWORD = 'mock-password-do-not-use';

/**
 * `POST /auth/login`.
 *
 * One message for "no such user" and "wrong password". Two different messages would
 * confirm which addresses have accounts, and enumerating registered citizens is
 * exactly the capability a reporting tool should not hand out.
 */
async function login(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const unexpected = rejectUnexpectedBearer(request);
  if (unexpected) {
    return unexpected;
  }

  let body: { email?: string; password?: string; clientType?: ClientType };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return unauthenticated(path, 'Email or password is incorrect.');
  }

  const user = body.email ? userByEmail(body.email) : undefined;
  if (!user || body.password !== MOCK_PASSWORD) {
    return unauthenticated(path, 'Email or password is incorrect.');
  }

  // Checked *after* the password, not before. A disabled account is refused with a
  // clear message, but only to a caller who already proved they own it - refusing
  // on the account state alone would turn "account disabled" into a probe for
  // whether an address is registered, which is the leak the single message above
  // exists to prevent.
  if (user.status === 'DISABLED') {
    return forbidden(path, 'This account has been disabled.');
  }

  const response: LoginResponse = {
    accessToken: `mock-token-${user.role}`,
    // Null on the wire for WEB, because the contract sets the refresh token as an
    // HttpOnly cookie there. A mock that returned it in the body would teach the UI
    // to read a refresh token out of a response, which is precisely the thing the
    // cookie exists to prevent.
    refreshToken: null,
    expiresIn: 900,
    clientType: body.clientType ?? 'WEB',
    user: asCurrentUser(user),
  };
  return HttpResponse.json(response);
}

/**
 * `POST /auth/refresh`.
 *
 * The contract carries the refresh token as an HttpOnly cookie, so the mock demands
 * one. That is not pedantry: `AuthService`'s interceptor sets `credentials:
 * 'include'`, and if the mock accepted the request without the cookie, a client that
 * forgot that header would pass every test and then fail on the one request that
 * keeps a session alive.
 *
 * There is no session lookup here, so the token is minted for the citizen account -
 * matching the pre-existing behaviour rather than inventing a rule the contract does
 * not describe. The real consequence is worth naming: **`TokenRefreshResponse` has no
 * `user` field**, so a refresh restores a token but not the signed-in identity, and
 * a hard reload currently leaves the app without a user. That is a contract gap,
 * not something a mock should paper over by returning a `user` the server will not.
 */
function refresh(request: Request): Response {
  const path = new URL(request.url).pathname;
  const unexpected = rejectUnexpectedBearer(request);
  if (unexpected) {
    return unexpected;
  }
  if (!request.headers.get('Cookie')?.includes('civiclens_refresh=')) {
    return unauthenticated(path, 'No refresh cookie.');
  }

  const citizen = state.users.find((user) => user.role === 'CITIZEN' && user.status === 'ACTIVE');
// `TokenRefreshResponse`, not `LoginResponse`. The two look nearly identical and the
 // difference is the whole point of the split: refresh carries no `user` and no
 // `clientType`. The previous version typed this as `LoginResponse` and passed
 // `user: undefined`, which type-checks against an optional field while still
 // emitting a `user` key - so the mock had a shape the real server never sends, and
 // session restore would have been the first thing to break against it.
  return HttpResponse.json({
    accessToken: `mock-token-${citizen?.role ?? 'CITIZEN'}`,
    refreshToken: null,
    expiresIn: 900,
  } satisfies TokenRefreshResponse);
}

export const sessionHandlers = [
  http.post(`${API}/auth/login`, ({ request }) => login(request)),
  http.post(`${API}/auth/refresh`, ({ request }) => refresh(request)),
  // 204 with no body, and no state change on the server's part. The refresh token
  // is a cookie the browser will drop; there is nothing to revoke here.
  http.post(`${API}/auth/logout`, () => new HttpResponse(null, { status: 204 })),
];
