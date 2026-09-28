import { setupServer } from 'msw/node';
import { TestBed } from '@angular/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createAuthInterceptor } from '../app/core/auth/auth.interceptor';
import { createTrackingTokenInterceptor } from '../app/core/tracking/tracking-token.interceptor';
import { AuthService } from '../app/core/auth/auth.service';
import { TokenStore } from '../app/core/token-store';
import { TrackingTokenStore } from '../app/core/tracking/tracking-token.store';
import { isSessionExempt } from '../app/core/api/session-policy';
import type { ResolvedRequestOptions } from '../app/api/generated/client';
import { handlers } from './handlers';
import { MOCK_TRACKING_TOKEN } from './fixtures';

/**
 * The credential rules, at both ends.
 *
 * `session-policy.spec.ts` unit-tests the policy function and cross-checks its
 * path list against the contract. What neither it nor a type check can catch is
 * the integration: a request that *should* carry no bearer going out with one.
 * That failure has no exception and no wrong type. The server simply accepts a
 * credential on a tree that has a different one, and the leak is invisible until
 * someone reads the logs.
 *
 * So both ends are checked here, with no generated client in the middle:
 *
 *   1. The interceptors, invoked exactly as the generated client invokes them,
 *      producing the `Request` that would go on the wire.
 *   2. The mock server, which refuses a misplaced credential the way the
 *      contract implies the real one will.
 */
const API = 'http://localhost:8080/api/v1';
const server = setupServer(...handlers);

/** A GET request the way the generated client builds one. */
function get(path: string): Request {
  return new Request(`${API}${path}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * The `ResolvedRequestOptions` the generated client passes alongside the request.
 *
 * Minimal on purpose, and asserted rather than assumed: `authInterceptor` and
 * `trackingTokenInterceptor` read the token and the URL off the `Request` itself
 * and never touch `options`, so stubbing it is faithful. If a future interceptor
 * did read it, the stub would be wrong and these tests would say so - which is a
 * better outcome than a full client construction that hid the header under three
 * layers of serialisation.
 */
const options = { headers: new Headers(), url: '/' } as ResolvedRequestOptions;

/**
 * Invoke an interceptor exactly as the generated client does, and await it.
 *
 * Deliberately *not* wrapped in `TestBed.runInInjectionContext`. That wrapper was
 * here to make `inject()` work inside the interceptors, and it hid a bug that
 * made every authenticated request in the real app throw `NG0203` - the
 * generated client provides no injection context, and the wrapper supplied one
 * the browser never would. The interceptors now take their dependency as a
 * parameter, so there is nothing to manufacture and a test that accidentally
 * reintroduces `inject()` here fails loudly.
 */
function runAuth(request: Request): Promise<Request> {
  return Promise.resolve(
    createAuthInterceptor(auth)(request, options),
  );
}

function runTracking(request: Request): Promise<Request> {
  return Promise.resolve(
    createTrackingTokenInterceptor(tracking)(request, options),
  );
}

/**
 * The services the interceptors close over, resolved the way `api-client.config`
 * resolves them: once, from the injector, at registration.
 */
let auth: AuthService;
let tracking: TrackingTokenStore;
let tokens: TokenStore;

function configure(): void {
  // Cleared *before* anything is constructed, not after. `TrackingTokenStore`
  // reads `localStorage` in its constructor, so a store built while a previous
  // test's token is still on disk keeps it in memory where clearing the storage
  // can no longer reach it. The result is a spec where "sends no token when none
  // is held" fails depending on which test ran before it.
  window.localStorage.clear();

  TestBed.configureTestingModule({ providers: [TokenStore, TrackingTokenStore] });
  tokens = TestBed.inject(TokenStore);
  auth = TestBed.inject(AuthService);
  tracking = TestBed.inject(TrackingTokenStore);
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
  configure();
});

afterEach(() => {
  server.resetHandlers();
  TestBed.resetTestingModule();
  configure();
});

afterAll(() => {
  server.close();
});

/**
 * Seed a session, as a successful login would.
 *
 * Goes through the same `TokenStore` instance the interceptor's closure holds,
 * captured by `configure`. Resolving a second time would work today and break
 * quietly the day the injector is reconfigured, and a spec that reports a
 * missing bearer because of test plumbing is worse than no spec.
 */
function signIn(accessToken: string): void {
  tokens.set(accessToken, 900);
}

describe('the bearer reaches only the paths that need it', () => {
  const needsBearer = [
    '/issues',
    '/issues/mine',
    '/admin/users',
    '/dashboard',
    '/notifications',
  ];
  const mustNotHaveBearer = [
    '/auth/login',
    '/auth/refresh',
    '/tracked/issues',
    '/tracked/issues/iss-1',
    '/contact/verify',
    '/public/issues/CL-2026-0002',
  ];

  it.each(needsBearer)('attaches a bearer to %s', async (path) => {
    signIn('mock-token-CITIZEN');

    const outgoing = await runAuth(get(path));

    expect(outgoing.headers.get('Authorization')).toBe('Bearer mock-token-CITIZEN');
    expect(isSessionExempt(path)).toBe(false);
  });

  it.each(mustNotHaveBearer)('withholds the bearer from %s', async (path) => {
    signIn('mock-token-CITIZEN');

    const outgoing = await runAuth(get(path));

    // The single most consequential assertion in the frontend. Two of these
    // paths are bearer-exempt in the contract because they have a different
    // credential entirely; the rest are public and must not leak a session to a
    // third party.
    expect(outgoing.headers.has('Authorization')).toBe(false);
  });

  it('attaches the bearer to /reference/**, which inherits the global security', async () => {
    // The counterpart to the public tree, and the reason the exempt list is
    // short. The contract does not mark `/reference/**` as `security: []`, so a
    // bearer is expected there. Withholding it "to be safe" would work until the
    // server started requiring a session, and the mock would have taught the UI
    // that the absence was fine.
    signIn('mock-token-CITIZEN');

    const outgoing = await runAuth(get('/reference/categories'));

    expect(outgoing.headers.get('Authorization')).toBe('Bearer mock-token-CITIZEN');
  });

  it('sends no bearer when nobody is signed in', async () => {
    const outgoing = await runAuth(get('/issues'));

    expect(outgoing.headers.has('Authorization')).toBe(false);
  });
});

describe('the tracking token reaches only the tracked tree', () => {
  it('attaches X-Tracking-Token to the tracked tree', async () => {
    tracking.save(MOCK_TRACKING_TOKEN);

    const outgoing = await runTracking(get('/tracked/issues'));

    expect(outgoing.headers.get('X-Tracking-Token')).toBe(MOCK_TRACKING_TOKEN);
    // And nothing else: the tracking token is the only credential this tree takes.
    expect(outgoing.headers.has('Authorization')).toBe(false);
  });

  it('never sends the tracking token anywhere else', async () => {
    tracking.save(MOCK_TRACKING_TOKEN);

    for (const path of ['/issues/mine', '/public/issues/CL-2026-0002', '/auth/login']) {
      const outgoing = await runTracking(get(path));
      expect(outgoing.headers.has('X-Tracking-Token'), `${path} must not carry the tracking token`)
        .toBe(false);
    }
  });

  it('sends no header at all when no report is being tracked', async () => {
    const outgoing = await runTracking(get('/tracked/issues'));

    // The header is absent, not empty. An empty `X-Tracking-Token` reads to the
    // server as an attempt and produces a 403 rather than the "no reports yet"
    // empty page a citizen with no tracked report should see.
    expect(outgoing.headers.has('X-Tracking-Token')).toBe(false);
  });
});

describe('the mock server refuses a misplaced credential', () => {
  it('rejects a bearer on the public tree', async () => {
    // `security: []` in the contract. A signed-in officer sending their session
    // to a public endpoint hands a live credential to something that does not
    // need it.
    const response = await fetch(`${API}/public/issues/CL-2026-0002`, {
      headers: { Authorization: 'Bearer mock-token-CITIZEN' },
    });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('VALIDATION_ERROR');
  });

  it('rejects a bearer on the tracked tree', async () => {
    // Two credentials for two trees. Accepting either on the other is how a
    // concealed report ends up readable by the wrong identity.
    const response = await fetch(`${API}/tracked/issues`, {
      headers: { Authorization: 'Bearer mock-token-CITIZEN' },
    });

    expect(response.status).toBe(403);
  });

  it('rejects a bearer on /auth/**', async () => {
    const response = await fetch(`${API}/auth/refresh`, {
      method: 'POST',
      headers: { Authorization: 'Bearer mock-token-CITIZEN' },
    });

    expect(response.status).toBe(401);
  });

  it('rejects a tracked call with the wrong token', async () => {
    const response = await fetch(`${API}/tracked/issues`, {
      headers: { 'X-Tracking-Token': 'not-the-token' },
    });

    expect(response.status).toBe(403);
  });

  it('serves the tracked tree to a correct token', async () => {
    const response = await fetch(`${API}/tracked/issues`, {
      headers: { 'X-Tracking-Token': MOCK_TRACKING_TOKEN },
    });
    const body = (await response.json()) as { content: Array<{ id: string }> };

    expect(response.status).toBe(200);
    expect(body.content[0]?.id).toBe('iss-concealed-1');
  });

  it('never returns a reporter identity for a concealed report', async () => {
    const response = await fetch(`${API}/tracked/issues/iss-concealed-1`, {
      headers: { 'X-Tracking-Token': MOCK_TRACKING_TOKEN },
    });
    const body = JSON.stringify(await response.json());

    // SPEC 7.1: concealment is structural - the response type has no reporter
    // field at all. Asserted over the whole serialised body rather than one
    // property, so a future `reporterName` would not slip past a narrower check.
    expect(body).not.toContain('reporter@example.org');
    expect(body).not.toContain('Sam Rivera');
    expect(body).toContain('CONCEALED');
  });

  it('logs in without putting a refresh token in the body', async () => {
    // SPEC 7.1 delivers the WEB refresh token as an HttpOnly cookie. A mock that
    // returned one in the body would let the UI grow a habit of reading it from
    // there, and that habit breaks the moment it reaches a browser.
    const response = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'reporter@example.org',
        password: 'mock-password-do-not-use',
        clientType: 'WEB',
      }),
    });
    const body = (await response.json()) as { accessToken: string; refreshToken: string | null };

    expect(body.accessToken).toBe('mock-token-CITIZEN');
    expect(body.refreshToken).toBeNull();
  });

  it('rejects a bad password with the contract error envelope', async () => {
    // The error path a citizen hits when they mistype, so the shape matters: the
    // contract's `ErrorEnvelope` with a `code`, not a bare 401 and an empty body.
    // A UI that has to special-case a missing code is a UI that will show nothing
    // useful on the most common error there is.
    const response = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'reporter@example.org',
        password: 'not-the-mock-password',
        clientType: 'WEB',
      }),
    });
    const body = (await response.json()) as { code: string; status: number; traceId: string };

    expect(response.status).toBe(401);
    expect(body.code).toBe('UNAUTHENTICATED');
    expect(body.traceId).toBeTruthy();
  });

  it('requires a disclosure choice on create', async () => {
    // SPEC 3.2, enforced on the server side as well as in the UI: no default.
    const response = await fetch(`${API}/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Pothole', description: 'Deep one' }),
    });
    const body = (await response.json()) as { code: string; details: Array<{ field: string }> };

    expect(response.status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details[0]?.field).toBe('disclosure');
  });

  it('refuses a concealed report with no contact channel or consent marker', async () => {
    const response = await fetch(`${API}/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Pothole', description: 'Deep one', disclosure: 'CONCEALED' }),
    });
    const body = (await response.json()) as { code: string };

    expect(response.status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('accepts a concealed report with a contact channel, and never echoes the address', async () => {
    const response = await fetch(`${API}/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Pothole',
        description: 'Deep one',
        disclosure: 'CONCEALED',
        reporterContact: { type: 'EMAIL', value: 'reporter@example.org' },
        contactDisclosureNote: '1',
      }),
    });
    const raw = await response.text();

    expect(response.status).toBe(201);
    // SPEC 7.1: the address is never returned in any response body, not even to
    // the reporter who supplied it - a response that returns it ends up in a log.
    expect(raw).not.toContain('reporter@example.org');
  });
});

