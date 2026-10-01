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
import { handlers, ISSUE_LIMITS } from './handlers';
import { MOCK_TRACKING_TOKEN, resetCreatedReportSequence, resetTrackedReports } from './fixtures';
import {
  idempotencyMismatches,
  idempotencyStore,
  resetIdempotency,
  setNetworkFingerprint,
} from './idempotency';
import type { IssueCreateResponse } from '../app/api/generated/types.gen';

/**
 * A `POST /issues` body, as multipart.
 *
 * The contract declares this endpoint `multipart/form-data` because a report
 * carries up to three photos, so this is the shape the generated client sends.
 * It is built at module scope rather than inside a `describe` because both
 * describe blocks that post to it need it.
 *
 * Coordinates are in the baseline because the contract requires them. Leaving
 * them out would mean every test about *some other* rule was silently also a
 * test about a missing coordinate.
 */
function issueBody(overrides: Record<string, string> = {}): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    title: 'Deep pothole',
    description: 'Outside the pharmacy, about a foot wide.',
    disclosure: 'SHARE_DETAILS',
    latitude: '51.5074',
    longitude: '-0.1278',
    ...overrides,
  })) {
    form.append(key, value);
  }
  return form;
}

/**
 * The `Idempotency-Key` every create must carry. `required: true` in the contract.
 *
 * A single constant rather than a fresh UUID per test, because the point of the
 * header is that the *same* key is replayed on a retry - so a test that minted a
 * new one each time would be asserting the opposite of what it means.
 */
const IDEMPOTENCY_KEY = '11111111-2222-4333-8444-555555555555';

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

/**
 * Cleared in `configure()` alongside `localStorage`, for the same reason and with
 * the same consequence if it is forgotten.
 *
 * The idempotency store is module state that outlives `server.resetHandlers()`, so
 * without this every test would share one cache. `IDEMPOTENCY_KEY` is a single
 * constant for the whole file, so a leaked entry would make every later create
 * return the *first* test's response - a suite that passes in an order-dependent
 * way and fails the moment vitest reorders or shards it.
 */
function resetMockState(): void {
  resetIdempotency();
  resetCreatedReportSequence();
  resetTrackedReports();
  setNetworkFingerprint('default-device');
}

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
  resetMockState();
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

    it('withholds the bearer from /reference/**, which is public', async () => {
      // Previously asserted the opposite: this test used to require a bearer on
      // `/reference/categories` because "the contract does not mark `/reference/**`
      // as `security: []`". That was the bug, not the specification - the endpoint
      // populates the report form, and `POST /issues` is public precisely so a
      // signed-out reporter can use it. A role requirement on the categories left
      // the form unusable for the concealed reporter SPEC 3.1 is written for, and
      // the mock served the endpoint unauthenticated, so development looked fine.
      //
      // The contract and this list are now both public, and `session-policy.spec.ts`
      // cross-checks that agreement in both directions so it cannot drift open
      // again from either side.
      signIn('mock-token-CITIZEN');

      const outgoing = await runAuth(get('/reference/categories'));

      expect(outgoing.headers.has('Authorization')).toBe(false);
    });

    it('still attaches the bearer to the trees that need it', async () => {
      // The counterpart to the public trees, and the reason the exempt list is
      // short. Withholding it "to be safe" would work until the server started
      // requiring a session, and the mock would have taught the UI that the
      // absence was fine.
      signIn('mock-token-CITIZEN');

      const outgoing = await runAuth(get('/issues/mine'));

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
    // 400 VALIDATION_ERROR, checked before the body is read. Not 401: the endpoint
    // declares no `bearerAuth`, so there is nothing to re-authenticate against, and a
    // 401 would send the client into a refresh-and-retry loop that can never
    // succeed. Refusing before the body is also parsed is the part that matters - the
    // status must not vary with whether the payload would have validated.
    const response = await fetch(`${API}/auth/refresh`, {
      method: 'POST',
      headers: { Authorization: 'Bearer mock-token-CITIZEN' },
    });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('VALIDATION_ERROR');
  });

  it('rejects a tracked call with the wrong token', async () => {
    // 404, not 403. An unrecognised token is indistinguishable from a token that is
    // valid for a report the caller cannot reach, and it has to stay that way: a 403
    // would confirm the token exists as a token, turning the tracked tree into an
    // oracle for guessing someone else's device token.
    const response = await fetch(`${API}/tracked/issues`, {
      headers: { 'X-Tracking-Token': 'not-the-token' },
    });

    expect(response.status).toBe(404);
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
    // The field is deleted rather than omitted from the overrides because
    // `issueBody` supplies a valid one by default - a test about the *absence*
    // of a field cannot be written by passing fewer fields than the baseline.
    const form = issueBody();
    form.delete('disclosure');

    const response = await fetch(`${API}/issues`, {
      method: 'POST',
      headers: { 'Idempotency-Key': IDEMPOTENCY_KEY },
      body: form,
    });
    const body = (await response.json()) as { code: string; details: Array<{ field: string }> };

    expect(response.status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details[0]?.field).toBe('disclosure');
  });

  it('refuses a concealed report with no contact channel or consent marker', async () => {
    const response = await fetch(`${API}/issues`, {
      method: 'POST',
      headers: { 'Idempotency-Key': IDEMPOTENCY_KEY },
      body: issueBody({ title: 'Pothole', description: 'Deep one', disclosure: 'CONCEALED' }),
    });
    const body = (await response.json()) as { code: string };

    expect(response.status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('accepts a concealed report with a contact channel, and never echoes the address', async () => {
    const response = await fetch(`${API}/issues`, {
      method: 'POST',
      headers: { 'Idempotency-Key': IDEMPOTENCY_KEY },
      // No title/description overrides: the `issueBody` baseline is already a
      // valid report, and overriding them with shorter strings used to produce a
      // description below the contract's `minLength` - which the length checks
      // now correctly reject, so this test had been quietly depending on the mock
      // not validating the fields it was claiming to model.
      body: issueBody({
        disclosure: 'CONCEALED',
        'reporterContact.type': 'EMAIL',
        'reporterContact.value': 'reporter@example.org',
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

/**
 * The `POST /issues` multipart contract.
 *
 * These three tests above used to post `application/json` and passed, which is
 * the bug rather than the proof: the endpoint is `multipart/form-data` in the
 * contract because a report carries up to three photos, and the mock was calling
 * `request.json()` to match the tests rather than the contract. The two agreed
 * with each other and neither agreed with the specification, so a client built
 * from the generated SDK - which correctly sends `FormData` - was rejected by the
 * one handler meant to model it.
 *
 * Type-checking could not catch it either, because the old handler hand-cast the
 * body to a local object type it defined itself. The response below is now built
 * as the contract's `IssueCreateResponse` and the request is parsed into the
 * contract's `IssueCreateForm`, so the mock and the specification cannot drift
 * apart without the compiler objecting.
 */
describe('create issue: multipart contract', () => {
  const post = (form: FormData, headers: Record<string, string> = {}) =>
    fetch(`${API}/issues`, {
      method: 'POST',
      headers: { 'Idempotency-Key': IDEMPOTENCY_KEY, ...headers },
      body: form,
    });

  it('requires the Idempotency-Key header', async () => {
    // `required: true` in the contract, and the generated `CreateIssueData` types
    // it as a required header, so the compiler already stops a form omitting it.
    // This is the mock half: a mock that ignored the header would let a form
    // mint a fresh key on every retry, which passes every other test here and
    // creates a duplicate report in production.
    const response = await fetch(`${API}/issues`, { method: 'POST', body: issueBody() });
    const body = (await response.json()) as { code: string; details: Array<{ field: string }> };

    expect(response.status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details[0]?.field).toBe('Idempotency-Key');
  });

  it('rejects an Idempotency-Key that is not a UUID', async () => {
    // `format: uuid` in the contract. A counter, a timestamp, or an all-zero
    // placeholder is what a client sends when it has not understood the header -
    // and every one of those collides in production while looking perfectly fine
    // against a mock that only checks for a non-empty string. `00000000-...` is
    // the specific one worth pinning: it is the value a client reaches for when
    // it has a header field and nothing to put in it, and a real UUID parser
    // rejects it because the version nibble is 0.
    for (const key of [
      'not-a-uuid',
      '00000000-0000-0000-0000-000000000000',
      '1',
      `${IDEMPOTENCY_KEY}-and-then-some-${'x'.repeat(80)}`,
    ]) {
      const response = await fetch(`${API}/issues`, {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: issueBody(),
      });

      expect(response.status, `expected ${key} to be rejected`).toBe(400);
    }

    // And the store stayed empty, so a rejected key cannot poison a later retry
    // that does use a valid one.
    expect(idempotencyStore.size).toBe(0);
  });

  it('parses a multipart body and answers with the contract response shape', async () => {
    const response = await post(issueBody());
    const body = (await response.json()) as IssueCreateResponse;

    expect(response.status).toBe(201);

    // The anti-drift assertion. Every key of `IssueCreateResponse`, named here,
    // so a response that quietly stops carrying the token or the share link
    // fails a test instead of a user's session.
    expect(Object.keys(body).sort()).toEqual(
      ['contactVerificationRequired', 'issue', 'publicShareUrl', 'trackingToken'].sort(),
    );

    // The echoed issue is a real `IssueDetail`, not a stub: a client that renders
    // the confirmation page needs the fields it will actually read.
    expect(body.issue.id).toBeTruthy();
    expect(body.issue.publicCode).toBeTruthy();
    expect(body.issue.title).toBe('Deep pothole');
    expect(body.issue.status).toBe('SUBMITTED');
    expect(typeof body.issue.latitude).toBe('number');
    expect(typeof body.issue.longitude).toBe('number');
  });

    it('hands back the one-time tracking token for a concealed report only', async () => {
      const concealed = (await (
        await post(
          issueBody({
            disclosure: 'CONCEALED',
            'reporterContact.type': 'EMAIL',
            'reporterContact.value': 'reporter@example.org',
            contactDisclosureNote: '1',
          }),
        )
      ).json()) as IssueCreateResponse;

      // The token is returned exactly once in a concealed report's life and is
      // unrecoverable afterwards, so the client must persist it before navigating
      // away. `contactVerificationRequired` is what stops the client navigating to a
      // status page that can never resolve, because a concealed report sits
      // unverified and out of every queue until the reporter proves the address.
      //
      // Asserted as "a token, and one this mock issued" rather than as a specific
      // string. It used to be pinned to `MOCK_TRACKING_TOKEN`, the fixture token
      // `/tracked/**` accepted - which asserted that the create endpoint handed out
      // one global credential, and is why the token is now derived from reporter
      // identity. The property that matters is that it is a real credential scoped
      // to this reporter, which is checked by opening it against `/tracked/**`.
      expect(concealed.trackingToken).toBeTruthy();
      expect(concealed.trackingToken).not.toBe(MOCK_TRACKING_TOKEN);
      expect(concealed.contactVerificationRequired).toBe(true);
      expect(concealed.issue.contactState).toBe('PENDING_VERIFICATION');

      // A different key, because this is a different submission. The first version
      // of this test reused `IDEMPOTENCY_KEY` for both posts and passed only because
      // the mock ignored the header; with replay implemented it started failing,
      // which is the mock catching a genuine client bug - one key reused for two
      // different payloads gets the *original* report back, by design, so a form
      // that mints one key for the whole session would silently discard the
      // reporter's second report.
      const shared = (await (
        await post(issueBody(), { 'Idempotency-Key': '22222222-3333-4444-8555-666666666666' })
      ).json()) as IssueCreateResponse;

      // A signed-in reporter's access comes from the session, so a shared report
      // has neither a token nor anything to verify. `trackingToken` is `null` rather
      // than absent because the contract types it as nullable - "absent" and "no
      // token" are different claims and the generated type keeps them apart.
      expect(shared.trackingToken).toBeNull();
      expect(shared.contactVerificationRequired).toBe(false);
    });

  it('reads the contact channel out of the flattened multipart fields', async () => {
    // Multipart has no nested objects, so the generated client flattens
    // `reporterContact` to `reporterContact.type` / `.value`. A handler reading
    // `form.get('reporterContact')` gets nothing and reports a missing contact
    // channel for a report that supplied one.
    const response = await post(
      issueBody({
        disclosure: 'CONCEALED',
        'reporterContact.type': 'EMAIL',
        'reporterContact.value': 'reporter@example.org',
        contactDisclosureNote: '1',
      }),
    );

    expect(response.status).toBe(201);
  });

  it('rejects a report with no coordinates, naming the field', async () => {
    // Previously unchecked. A client that dropped the coordinates would have been
    // answered with a 201 and an issue located at null island.
    const form = issueBody();
    form.delete('latitude');
    form.delete('longitude');

    const response = await post(form);
    const body = (await response.json()) as { code: string; details: Array<{ field: string }> };

    expect(response.status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details.map((d) => d.field)).toEqual(['latitude', 'longitude']);
  });

  it('treats an empty coordinate as missing rather than as 0,0', async () => {
    // `Number('')` is `0`, which is a real coordinate in the Gulf of Guinea. A
    // report that silently landed there would be geographically valid and
    // completely wrong, and harder to notice than a rejected submission.
    const response = await post(issueBody({ latitude: '', longitude: '' }));
    const body = (await response.json()) as { details: Array<{ field: string }> };

    expect(response.status).toBe(400);
    expect(body.details.map((d) => d.field)).toContain('latitude');
  });

  it('requires the citizen wording for OTHER and refuses it for any other category', async () => {    const missing = await post(issueBody({ categoryId: 'cat-other' }));
    const missingBody = (await missing.json()) as { details: Array<{ field: string }> };
    expect(missing.status).toBe(400);
    expect(missingBody.details.map((d) => d.field)).toContain('proposedCategoryText');

    // A proposal attached to a category that already fits is a duplicate waiting
    // to happen: it is stored as something a manager maps onto the taxonomy at
    // triage, and it is rejected rather than silently dropped.
    const extra = await post(
      issueBody({ categoryId: 'cat-roads', proposedCategoryText: 'Actually a drain' }),
    );
    const extraBody = (await extra.json()) as { details: Array<{ field: string }> };
    expect(extra.status).toBe(400);
    expect(extraBody.details.map((d) => d.field)).toContain('proposedCategoryText');

    const correct = await post(
      issueBody({ categoryId: 'cat-other', proposedCategoryText: 'Dog bin overflowing' }),
    );
    expect(correct.status).toBe(201);
  });

  it('refuses a contact channel on a shared report', async () => {
    // The mirror of the concealed rule, and it matters for the same reason: the
    // address has to end up not stored, and the only reliable way to achieve that
    // is to refuse to accept it. Without this, a UI could grow a habit of sending
    // contact details on every submission and nothing would object.
    const response = await post(
      issueBody({
        disclosure: 'SHARE_DETAILS',
        'reporterContact.type': 'EMAIL',
        'reporterContact.value': 'reporter@example.org',
        contactDisclosureNote: '1',
      }),
    );
    const body = (await response.json()) as { details: Array<{ field: string }> };

    expect(response.status).toBe(400);
    expect(body.details.map((d) => d.field)).toContain('reporterContact');
  });

  it('withholds the tracking token from a signed-in reporter', async () => {
    // "Present only for a concealed submission. Absent (null) for a signed-in
    // citizen, whose access comes from their session instead." A signed-in
    // reporter is answered with `null` even when they choose CONCEALED - their
    // concealment rests on staff not seeing their identity, not on withholding
    // their own account from themselves.
    //
    // A test that only ever posts anonymously cannot see this rule at all, which
    // is the whole reason it is asserted here rather than left to inspection.
    const response = await fetch(`${API}/issues`, {
      method: 'POST',
      headers: {
        'Idempotency-Key': IDEMPOTENCY_KEY,
        Authorization: 'Bearer mock-token-CITIZEN',
      },
      body: issueBody({
        disclosure: 'CONCEALED',
        'reporterContact.type': 'EMAIL',
        'reporterContact.value': 'reporter@example.org',
        contactDisclosureNote: '1',
      }),
    });
    const body = (await response.json()) as IssueCreateResponse;

    expect(response.status).toBe(201);
    expect(body.trackingToken).toBeNull();
    // The disclosure decision itself is untouched: a signed-in reporter still
    // conceals, and the report still needs its contact channel verified.
    expect(body.contactVerificationRequired).toBe(true);
  });

  it('enforces the contract length and range limits on every bounded field', async () => {
    // The bounds are read from `ISSUE_LIMITS` rather than restated here. A test
    // that copied the numbers would keep passing after the contract moved them,
    // which is the divergence this whole exercise exists to prevent.
    const cases: Array<{ field: string; value: string }> = [
      { field: 'title', value: 'a'.repeat(ISSUE_LIMITS.title.minLength - 1) },
      { field: 'title', value: 'a'.repeat(ISSUE_LIMITS.title.maxLength + 1) },
      { field: 'description', value: 'b'.repeat(ISSUE_LIMITS.description.minLength - 1) },
      { field: 'description', value: 'b'.repeat(ISSUE_LIMITS.description.maxLength + 1) },
      { field: 'address', value: 'c'.repeat(ISSUE_LIMITS.address.maxLength + 1) },
      { field: 'latitude', value: String(ISSUE_LIMITS.latitude.max + 1) },
      { field: 'latitude', value: String(ISSUE_LIMITS.latitude.min - 1) },
      { field: 'longitude', value: String(ISSUE_LIMITS.longitude.max + 1) },
      { field: 'longitude', value: String(ISSUE_LIMITS.longitude.min - 1) },
    ];

    for (const { field, value } of cases) {
      const response = await post(issueBody({ [field]: value }));
      const body = (await response.json()) as { code: string; details: Array<{ field: string }> };

      expect(response.status, `${field}="${value.slice(0, 12)}..." should be rejected`).toBe(400);
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.details.map((d) => d.field), `should name ${field}`).toContain(field);
    }
  });

  it('reports a missing field once, not also as too short', async () => {
    // Presence is decided before length. A reporter fixing a form wants "this is
    // missing", not "this is missing and also too short" - two errors for one
    // problem is the kind of noise that makes people give up on a form.
    const form = issueBody();
    form.delete('title');

    const response = await post(form);
    const body = (await response.json()) as { details: Array<{ field: string }> };

    expect(response.status).toBe(400);
    expect(body.details.filter((d) => d.field === 'title')).toHaveLength(1);
  });
});

/**
 * Idempotent replay on `POST /issues`.
 *
 * Every test here fails if the cache is removed, and that is the point. The rest
 * of the create-issue suite cannot detect a missing cache at all: without one,
 * every request is a fresh report, every response has the right shape, and the
 * only symptom is a citizen who files twice and gets two reports with two
 * different share links - which no assertion in this file would have flagged.
 *
 * The rules are the contract's (`IdempotencyKey` in civiclens-v1.yaml), not
 * guesses about what a cache ought to do.
 */
describe('create issue: idempotent replay', () => {
  const concealedBody = () =>
    issueBody({
      disclosure: 'CONCEALED',
      'reporterContact.type': 'EMAIL',
      'reporterContact.value': 'reporter@example.org',
      contactDisclosureNote: '1',
    });

  const post = (form: FormData, key = IDEMPOTENCY_KEY, headers: Record<string, string> = {}) =>
    fetch(`${API}/issues`, {
      method: 'POST',
      headers: { 'Idempotency-Key': key, ...headers },
      body: form,
    });

  it('replays the original 201 body on a retry, including the tracking token', async () => {
    // The rule that matters. "Replaying the same key from the same reporter
    // returns the original 201 body rather than creating a second report."
    //
    // Asserted on the *whole* body rather than the status, because a cache that
    // returned 201 with a freshly-minted token would satisfy a status-only
    // assertion. The token is the specific field that would break: a concealed
    // reporter who loses the token loses their report permanently, and the
    // contract says the server re-derives it precisely so a retry cannot strand
    // them.
    const first = (await (await post(concealedBody())).json()) as IssueCreateResponse;
    const second = (await (await post(concealedBody())).json()) as IssueCreateResponse;

    expect(first.trackingToken).toBeTruthy();
    expect(second).toEqual(first);
    expect(second.trackingToken).toBe(first.trackingToken);
    expect(second.issue.id).toBe(first.issue.id);
    expect(second.publicShareUrl).toBe(first.publicShareUrl);
  });

  it('creates one report for two attempts, not two reports', async () => {
    // The same fact as the test above, seen from the other side: the *server* must
    // not have gained a report. Two identical bodies with the same key produce
    // one public code, and a second one would be a duplicate report sitting in the
    // queue that P2's duplicate detection then has to clean up.
    const first = (await (await post(concealedBody())).json()) as IssueCreateResponse;
    const second = (await (await post(concealedBody())).json()) as IssueCreateResponse;

    expect(second.issue.publicCode).toBe(first.issue.publicCode);
  });

  it('replays a retry without re-validating a body that already passed', async () => {
    // The replay check runs before validation, deliberately. A reporter who has
    // already been given their report and whose retry is answered with a 400 has
    // been told, wrongly, that they have no report - a far worse outcome than the
    // duplicate the header exists to prevent. This pins the ordering, which is the
    // part that is easy to get wrong when a validation block is added later.
    const first = (await (await post(concealedBody())).json()) as IssueCreateResponse;
    expect(first.issue.id).toBeTruthy();

    // Same key, same reporter, but a body that is invalid *on its own terms* -
    // an unknown disclosure. A validation-first implementation answers 400 here.
    const second = await post(
      issueBody({ disclosure: 'SOMETHING_ELSE', title: '' }),
      IDEMPOTENCY_KEY,
    );
    const body = (await second.json()) as IssueCreateResponse;

    expect(second.status).toBe(201);
    expect(body).toEqual(first);
  });

  it('scopes a replay to the reporter, so two devices do not share a cache', async () => {
    // "The same reporter" means the user id when signed in and the salted IP hash
    // when concealed - "so one concealed reporter retrying cannot collide with an
    // unrelated concealed reporter who happened to generate the same UUID."
    //
    // Two *different* UUIDs would not exercise this, and neither would one key with
    // one payload: the point is that the same key from a different identity is a
    // different submission, not a replay.
    setNetworkFingerprint('device-one');
    const first = (await (await post(concealedBody())).json()) as IssueCreateResponse;

    setNetworkFingerprint('device-two');
    const second = (await (await post(concealedBody())).json()) as IssueCreateResponse;

    expect(second.issue.id).not.toBe(first.issue.id);
    // Different devices, so different tokens: this is the one-token-per-device
    // rule from `GET /tracked/issues`, and it is why a report is not reachable by
    // another citizen's token.
    expect(second.trackingToken).not.toBe(first.trackingToken);
  });

  it('scopes a replay by user id, not by role, when signed in', async () => {
    // A cache keyed on the role would be a cross-tenant read: every signed-in
    // citizen is `CITIZEN`, so one citizen's retry would return another citizen's
    // report. The mock has one account per role, so this asserts the *mechanism* -
    // the key includes an identity that is not simply "is signed in" - by checking
    // that a signed-in submission does not replay an anonymous one under the same
    // key.
    setNetworkFingerprint('device-one');
    const anonymous = (await (await post(concealedBody())).json()) as IssueCreateResponse;

    const signedIn = (await (
      await post(concealedBody(), IDEMPOTENCY_KEY, { Authorization: 'Bearer mock-token-CITIZEN' })
    ).json()) as IssueCreateResponse;

    expect(signedIn.issue.id).not.toBe(anonymous.issue.id);
  });

  it('returns the original report and creates nothing when a key is reused with a different payload', async () => {
    // Deliberately NOT a 409. The contract chooses to fail toward keeping the
    // citizen's original report: "the original report is returned unchanged, the
    // mismatch is logged, and no second report is created - so the bug is visible
    // rather than silently dropping a citizen's report."
    //
    // So the assertion is on the response being the *original*, and on the log
    // having recorded it. Without the log check the branch is unobservable: the
    // mismatch path and the normal replay path return byte-identical bodies, so a
    // test could only prove the cache worked, never that the mismatch was noticed.
    const first = (await (await post(concealedBody())).json()) as IssueCreateResponse;

    const response = await post(
      issueBody({ title: 'A completely different problem', disclosure: 'CONCEALED',
        'reporterContact.type': 'EMAIL', 'reporterContact.value': 'reporter@example.org',
        contactDisclosureNote: '1' }),
    );
    const body = (await response.json()) as IssueCreateResponse;

    expect(response.status).toBe(201);
    expect(body).toEqual(first);
    expect(idempotencyMismatches).toHaveLength(1);
    expect(idempotencyMismatches[0]).toContain(IDEMPOTENCY_KEY);
  });

  it('does not record a submission that failed validation', async () => {
    // Only successful submissions are cached. A citizen who hit a validation error,
    // fixed the field and retried with the same key must get a fresh evaluation -
    // replaying the rejection would lock them out of a form they can now complete,
    // and the key is meant to survive the retry precisely because the *submission*
    // is still the same one.
    const invalid = issueBody({ title: '' });
    expect((await post(invalid)).status).toBe(400);
    expect(idempotencyStore.size).toBe(0);

    const fixed = (await (await post(issueBody())).json()) as IssueCreateResponse;
    expect(fixed.issue.id).toBeTruthy();
  });

  it('keeps one token across several reports, so a device accumulates reports', async () => {
    // `GET /tracked/issues` is a list, and the contract says a reporter
    // "accumulates several reports under one token, so this is a list and not a
    // single resource". Two different keys are two different submissions, so this
    // is the case where the second report must *not* be a replay - and it must land
    // under the same token.
    const otherKey = '99999999-8888-4777-aaaa-bbbbbbbbbbbb';

    const first = (await (await post(concealedBody())).json()) as IssueCreateResponse;
    const second = (await (await post(concealedBody(), otherKey)).json()) as IssueCreateResponse;

    expect(second.issue.id).not.toBe(first.issue.id);
    expect(second.trackingToken).toBe(first.trackingToken);
  });

  it('hands out a token that actually opens the report it was issued for', async () => {
    // The end-to-end consequence, and the reason the token is re-derived rather
    // than minted per submission. Before this, the mock returned one hard-coded
    // token for `/tracked/**` while handing out a different one on create, so a
    // citizen who filed a report as an anonymous reporter got a credential that
    // led to a 403 - the mock modelled a system where filing as a citizen costs
    // you access to your own report.
    const created = (await (await post(concealedBody())).json()) as IssueCreateResponse;
    const token = created.trackingToken!;

    const list = await fetch(`${API}/tracked/issues`, {
      headers: { 'X-Tracking-Token': token },
    });
    const listBody = (await list.json()) as { content: Array<{ id: string }> };

    expect(list.status).toBe(200);
    expect(listBody.content.map((issue) => issue.id)).toContain(created.issue.id);

    const detail = await fetch(`${API}/tracked/issues/${created.issue.id}`, {
      headers: { 'X-Tracking-Token': token },
    });

    expect(detail.status).toBe(200);
  });

  it('does not let one token open another token\'s report', async () => {
    setNetworkFingerprint('device-one');
    const mine = (await (await post(concealedBody())).json()) as IssueCreateResponse;

    setNetworkFingerprint('device-two');
    const yours = (await (await post(concealedBody())).json()) as IssueCreateResponse;

    const response = await fetch(`${API}/tracked/issues/${yours.issue.id}`, {
      headers: { 'X-Tracking-Token': mine.trackingToken! },
    });

    // 404 rather than 403: a caller holding a valid token is not told whether the
    // id it guessed exists somewhere else.
    expect(response.status).toBe(404);
  });
});

