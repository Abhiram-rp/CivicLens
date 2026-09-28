import { setupServer } from 'msw/node';
import { HttpResponse, http } from 'msw';
import { Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Issues } from '../../api/generated';
import { client } from '../../api/generated/client.gen';
import type { IssueSummaryPage } from '../../api/generated';
import { call } from '../api/api-call';
import { configureApiClient, resetApiClientForTest } from '../api/api-client.config';
import { TokenStore } from '../token-store';
import { resetRefreshStateForTest } from './refresh.interceptor';
import { AuthService } from './auth.service';

const API = 'http://localhost:8080/api/v1';

/**
 * The refresh path, end to end through the real interceptor chain.
 *
 * Everything else in `core/auth` is unit-tested against fakes, and all of that
 * passes while this file's subject is broken. The properties below are properties
 * of the *composition* - four interceptors, one SDK, one in-flight promise - and
 * none of them exist in any single unit:
 *
 * - a 401 is repaired without the citizen seeing it;
 * - four simultaneous 401s cost exactly one refresh.
 *
 * The second is the one that matters. SPEC 7.1 rotates the refresh token on every
 * use and treats presentation of an already-revoked token as theft, answering by
 * revoking the whole family. So the cost of collapsing concurrent 401s incorrectly
 * is not four extra requests: it is a signed-in citizen being logged out and an
 * alert that looks like an account compromise. A `finally` that failed to clear
 * the promise, or a missing `??=`, produces that on a dashboard that fires five
 * calls at once - and passes every unit test, because each unit starts with
 * `inFlightRefresh === null`.
 */

/** Counted at the server, because that is the only place the count is real. */
interface CallLog {
  mine: number;
  refresh: number;
  mineBearers: Array<string | null>;
  refreshBearers: Array<string | null>;
}

let calls: CallLog;
let /** How many `mine` calls should 401 before succeeding. */
expiredCalls: number;

const EMPTY_PAGE: IssueSummaryPage = {
  content: [],
  page: 0,
  size: 20,
  totalElements: 0,
  totalPages: 0,
  hasNext: false,
};

/**
 * The app's own call path, not a bare SDK promise.
 *
 * call is what unwraps the generated { data } | { error } union, so using it
 * here means a failure rejects the way it rejects in a feature - and that a
 * success hands back the payload rather than a result envelope. Calling the SDK
 * directly and asserting on .data would test a shape no component ever sees.
 */
function listMine(): Promise<IssueSummaryPage> {
  return call<IssueSummaryPage>(Issues.listMyIssues());
}

const server = setupServer(
  // The endpoint under test. 401s while it believes the access token is expired,
  // then 200 - which is exactly the shape a real expiry produces.
  http.get(`${API}/issues/mine`, ({ request }) => {
    calls.mine += 1;
    calls.mineBearers.push(request.headers.get('Authorization'));
    if (calls.mine <= expiredCalls) {
      return HttpResponse.json(
        { code: 'UNAUTHENTICATED', message: 'Access token expired', status: 401, traceId: 't-mine' },
        { status: 401 },
      );
    }
    return HttpResponse.json(EMPTY_PAGE);
  }),

  http.post(`${API}/auth/refresh`, ({ request }) => {
    calls.refresh += 1;
    calls.refreshBearers.push(request.headers.get('Authorization'));
    return HttpResponse.json({ accessToken: 'access-after-refresh', expiresIn: 900 });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

beforeEach(() => {
  calls = {
    mine: 0,
    refresh: 0,
    mineBearers: [],
    refreshBearers: [],
  };
  // Expired by default: the ordinary case this interceptor exists for.
  expiredCalls = Number.POSITIVE_INFINITY;

  TestBed.configureTestingModule({});
  resetApiClientForTest();
  resetRefreshStateForTest();
  // The real registration path, injector and all. The first version of this file
  // passed no injector because `configureApiClient` did not take one, and the
  // interceptors reached for `AuthService` with `inject()` instead - which the
  // generated client has no context to provide. Every test failed with NG0203,
  // which is the finding: the whole credential chain threw on the first request
  // in a real browser, and `mock/handlers.spec.ts` had been hiding it by wrapping
  // every interceptor call in `runInInjectionContext`.
  configureApiClient(TestBed.inject(Injector));
});

afterEach(() => {
  resetApiClientForTest();
  resetRefreshStateForTest();
  TestBed.resetTestingModule();
});

/** Sign in with a token the server will reject until it has been refreshed. */
function signIn(): void {
  TestBed.inject(TokenStore).set('access-expired', 900);
}

describe('a 401 is repaired transparently', () => {
  it('refreshes once, replays the request, and returns the retried result', async () => {
    expiredCalls = 1;
    signIn();

    const page = await listMine();

    expect(calls.refresh).toBe(1);
    expect(calls.mine).toBe(2);
    // The caller gets a page, not an error: nobody should see a spinner because
    // their token was four minutes old.
    expect(page.content).toEqual([]);
  });

  it('replays with the new token, not the expired one', async () => {
    expiredCalls = 1;
    signIn();

    await listMine();

    expect(calls.mineBearers[0]).toBe('Bearer access-expired');
    expect(calls.mineBearers[1]).toBe('Bearer access-after-refresh');
  });

  it('leaves a successful call alone', async () => {
    expiredCalls = 0;
    signIn();

    await listMine();

    expect(calls.mine).toBe(1);
    expect(calls.refresh).toBe(0);
  });

  it('reauthenticates through the cookie, never with the dead bearer', async () => {
    // The bearer is expired by definition. Sending it would be rejected again,
    // and on a real server a stale bearer alongside a valid cookie is how a
    // refresh endpoint decides you are not signed in.
    expiredCalls = 1;
    signIn();

    await listMine();

    expect(calls.refreshBearers[0]).toBeNull();
  });

  it('opts the whole client into sending the refresh cookie', async () => {
    // Asserted as configuration rather than as an observed `Cookie` header,
    // because a header is the wrong thing to assert here: the test environment
    // has no cookie jar, so `credentials: 'include'` legitimately attaches
    // nothing, and asserting the header would either pass vacuously or need a
    // fake jar that proved nothing about the browser.
    //
    // What matters is the one setting that makes the browser send it. Miss this
    // and the session silently expires every fifteen minutes while every screen
    // looks perfectly healthy - no error, just a citizen who is mysteriously
    // signed out.
    expect(client.getConfig().credentials).toBe('include');
  });
});

describe('concurrent 401s cost exactly one refresh', () => {
  it('collapses four simultaneous expiries into a single refresh', async () => {
    // The dashboard case. Every one of these is rejected on first contact.
    expiredCalls = 4;
    signIn();

    const results = await Promise.all([listMine(), listMine(), listMine(), listMine()]);

    expect(calls.refresh).toBe(1);
    // Four rejected, four replayed, four answered.
    expect(calls.mine).toBe(8);
    for (const page of results) {
      expect(page.content).toEqual([]);
    }
  });

  it('does not leave the shared promise stuck, so the next expiry refreshes again', async () => {
    // The failure mode of the collapse itself: if `inFlightRefresh` is never
    // cleared, the *first* refresh works and every later one silently reuses a
    // resolved promise. A session that appears to work for an hour and then
    // 401s forever is the worst shape this bug could take, because the refresh
    // counter still looks healthy in the first test above.
    signIn();

    expiredCalls = 1;
    await listMine();
    const afterFirst = calls.refresh;

    expiredCalls = Number.POSITIVE_INFINITY;
    calls.mine = 0;
    expiredCalls = 1;
    await listMine();

    expect(calls.refresh).toBe(afterFirst + 1);
  });
});

describe('the interceptor refuses to make a bad situation worse', () => {
  it('does not refresh again when the replay is also rejected', async () => {
    // An account that was disabled mid-session answers 401 forever. Without the
    // retry marker this would refresh and replay until the tab was closed, and
    // every one of those refreshes is a replayed token.
    expiredCalls = Number.POSITIVE_INFINITY;
    signIn();

    await expect(listMine()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    expect(calls.mine).toBe(2); // original + one replay, no more
    expect(calls.refresh).toBe(1);
  });

  it('clears the local session when the refresh itself is rejected', async () => {
    // The cookie is gone, expired or revoked: there is nothing left to try. The
    // session has to go with it, or a guard sends the citizen onwards believing
    // they are signed in and they land back on a page that keeps failing.
    expiredCalls = Number.POSITIVE_INFINITY;
    signIn();
    server.use(
      http.post(`${API}/auth/refresh`, () =>
        HttpResponse.json(
          { code: 'UNAUTHENTICATED', message: 'Refresh token revoked', status: 401, traceId: 't' },
          { status: 401 },
        ),
      ),
    );

    await expect(listMine()).rejects.toBeDefined();

    expect(TestBed.inject(AuthService).snapshot).toBeNull();
    expect(TestBed.inject(TokenStore).current()).toBeNull();
  });

  it('recovers after a failed refresh, rather than being wedged signed out', async () => {
    // The counterpart to the previous test, and the one that catches a
    // `clearSession()` that also refuses to let a later refresh through.
    expiredCalls = Number.POSITIVE_INFINITY;
    signIn();
    server.use(
      http.post(`${API}/auth/refresh`, () =>
        HttpResponse.json({ code: 'UNAUTHENTICATED', message: 'nope', status: 401 }, { status: 401 }),
      ),
    );
    await expect(listMine()).rejects.toBeDefined();

    server.resetHandlers();
    expiredCalls = 0;
    TestBed.inject(TokenStore).set('access-restored', 900);

    const page = await listMine();

    expect(page.content).toEqual([]);
  });
});
