import { http, HttpResponse } from 'msw';
import type { ErrorEnvelope } from '../app/api/generated/types.gen';
import {
  ACCOUNTS,
  CATEGORIES,
  ISSUES,
  MOCK_PASSWORD,
  MOCK_TRACKING_TOKEN,
  NOTIFICATIONS,
  PUBLIC_ISSUE,
  TRACKED_ISSUE,
  issuePage,
  notificationPage,
} from './fixtures';

/**
 * Development mock server.
 *
 * These handlers are deliberately not a happy-path stub. Each one reproduces the
 * *authorisation* rule from the contract, because a mock that answers every
 * request with 200 will happily develop a screen against a request the real
 * server rejects - and the screen then works in the demo and 403s in production.
 * The rules enforced here:
 *
 *   - `/tracked/**` accepts only `X-Tracking-Token`, and rejects a request that
 *     arrives with a session bearer instead. Two credentials for two trees.
 *   - `/public/**` and `/reference/**` reject an `Authorization` header. If a
 *     bearer is attached where the contract says `security: []`, that is a bug
 *     in `session-policy.ts` and the mock is where it shows up.
 *   - `/auth/**` rejects a bearer for the same reason.
 *   - Staff trees require a role, and the role comes from the token, not from
 *     the request body.
 *
 * Each rejection uses the contract's own `ErrorEnvelope`, including `traceId`,
 * so the error-handling path gets exercised rather than skipped.
 */

const API = '*/api/v1';

let traceCounter = 0;

function envelope(
  status: number,
  code: ErrorEnvelope['code'],
  message: string,
  path: string,
  details?: ErrorEnvelope['details'],
): ErrorEnvelope {
  return {
    timestamp: '2026-03-02T09:15:00.000Z',
    status,
    code,
    message,
    path,
    traceId: `mock-trace-${(++traceCounter).toString().padStart(6, '0')}`,
    ...(details ? { details } : {}),
  };
}

const unauthenticated = (path: string): HttpResponse<ErrorEnvelope> =>
  HttpResponse.json(envelope(401, 'UNAUTHENTICATED', 'Authentication required.', path), {
    status: 401,
  });

const forbidden = (path: string, message = 'You do not have access to this resource.'): HttpResponse<ErrorEnvelope> =>
  HttpResponse.json(envelope(403, 'FORBIDDEN', message, path), { status: 403 });

const notFound = (path: string, message = 'Not found.'): HttpResponse<ErrorEnvelope> =>
  HttpResponse.json(envelope(404, 'NOT_FOUND', message, path), { status: 404 });

/** Pull the role out of a mock bearer: `mock-token-<role>`. */
function roleFromToken(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer mock-token-')) {
    return null;
  }
  return auth.slice('Bearer mock-token-'.length);
}

/** The `/auth/**` rule: a bearer is a defect here, so it fails loudly. */
function rejectUnexpectedBearer(request: Request): HttpResponse<ErrorEnvelope> | null {
  if (request.headers.has('Authorization')) {
    return HttpResponse.json(
      envelope(
        401,
        'UNAUTHENTICATED',
        'This endpoint does not accept an Authorization header.',
        new URL(request.url).pathname,
      ),
      { status: 401 },
    );
  }
  return null;
}

export const handlers = [
  // --- auth -------------------------------------------------------------------------------------

  http.post(`${API}/auth/login`, async ({ request }) => {
    const path = new URL(request.url).pathname;
    const unexpected = rejectUnexpectedBearer(request);
    if (unexpected) {
      return unexpected;
    }

    const body = (await request.json()) as { email?: string; password?: string; clientType?: string };
    const user = body.email ? ACCOUNTS[body.email.toLowerCase()] : undefined;

    if (!user || body.password !== MOCK_PASSWORD) {
      return HttpResponse.json(
        envelope(401, 'UNAUTHENTICATED', 'Email or password is incorrect.', path),
        { status: 401 },
      );
    }

    return HttpResponse.json({
      accessToken: `mock-token-${user.role}`,
      // The contract sets the WEB refresh token as an HttpOnly cookie and leaves
      // this null; a mock that returned it here would teach the UI to read a
      // refresh token out of a response body, which the WEB client must never do.
      refreshToken: null,
      expiresIn: 900,
      clientType: body.clientType ?? 'WEB',
      user,
    });
  }),

  http.post(`${API}/auth/refresh`, ({ request }) => {
    const path = new URL(request.url).pathname;
    const unexpected = rejectUnexpectedBearer(request);
    if (unexpected) {
      return unexpected;
    }
    // Real: the HttpOnly cookie. Mock: a cookie the request must actually carry,
    // so the interceptor's `credentials: 'include'` is genuinely required.
    if (!request.headers.get('Cookie')?.includes('civiclens_refresh=')) {
      return unauthenticated(path);
    }
    return HttpResponse.json({
      accessToken: 'mock-token-CITIZEN',
      refreshToken: null,
      expiresIn: 900,
      clientType: 'WEB',
      user: ACCOUNTS['reporter@example.org'],
    });
  }),

  http.post(`${API}/auth/logout`, () => new HttpResponse(null, { status: 204 })),

  http.get(`${API}/auth/me`, ({ request }) => {
    const path = new URL(request.url).pathname;
    const role = roleFromToken(request);
    if (!role) {
      return unauthenticated(path);
    }
    const user = Object.values(ACCOUNTS).find((candidate) => candidate.role === role);
    return user ? HttpResponse.json(user) : unauthenticated(path);
  }),

  // --- issues -----------------------------------------------------------------------------------

  http.post(`${API}/issues`, async ({ request }) => {
    const path = new URL(request.url).pathname;
    const body = (await request.json()) as {
      title?: string;
      description?: string;
      disclosure?: string;
      reporterContact?: { type: string; value: string };
      contactDisclosureNote?: string;
    };

    // SPEC 3.2, enforced here as well as in the UI: `disclosure` is required with
    // no default, and a concealed report needs a contact channel and the
    // explicit consent marker.
    if (body.disclosure !== 'SHARE_DETAILS' && body.disclosure !== 'CONCEALED') {
      return HttpResponse.json(
        envelope(400, 'VALIDATION_ERROR', 'A disclosure choice is required.', path, [
          { field: 'disclosure', issue: 'Must be SHARE_DETAILS or CONCEALED.' },
        ]),
        { status: 400 },
      );
    }

    if (body.disclosure === 'CONCEALED') {
      const missing = [
        body.reporterContact ? null : 'reporterContact',
        body.contactDisclosureNote === '1' ? null : 'contactDisclosureNote',
      ].filter(Boolean);
      if (missing.length > 0) {
        return HttpResponse.json(
          envelope(400, 'VALIDATION_ERROR', 'A concealed report needs a contact channel.', path, [
            { field: missing[0]!, issue: 'Required when disclosure is CONCEALED.' },
          ]),
          { status: 400 },
        );
      }
    }

    // SPEC 7.1: the contact address is never echoed back, to anyone. A mock that
    // returned it would let a UI get comfortable displaying it.
    return HttpResponse.json(
      {
        id: 'iss-mock-new',
        publicCode: 'CL-2026-0003',
        status: 'SUBMITTED',
        statusLabel: 'Received',
        disclosure: body.disclosure,
        createdAt: '2026-03-02T09:15:00.000Z',
      },
      { status: 201 },
    );
  }),

  http.get(`${API}/issues`, ({ request }) => {
    const path = new URL(request.url).pathname;
    const role = roleFromToken(request);
    if (!role) {
      return unauthenticated(path);
    }
    if (role === 'CITIZEN') {
      return forbidden(path, 'Use GET /issues/mine for your own reports.');
    }
    return HttpResponse.json(issuePage(ISSUES));
  }),

  http.get(`${API}/issues/mine`, ({ request }) => {
    const path = new URL(request.url).pathname;
    // A citizen's own reports, or a concealed reporter's via the tracked tree.
    // This endpoint answers to a session only.
    if (!roleFromToken(request)) {
      return unauthenticated(path);
    }
    return HttpResponse.json(issuePage([ISSUES[0]!]));
  }),

  http.get(`${API}/issues/:issueId`, ({ request, params }) => {
    const path = new URL(request.url).pathname;
    const role = roleFromToken(request);
    if (!role) {
      return unauthenticated(path);
    }
    if (role === 'CITIZEN') {
      return forbidden(path, 'A concealed report is only reachable through /tracked.');
    }
    const issue = ISSUES.find((candidate) => candidate.id === params['issueId']);
    return issue ? HttpResponse.json(issue) : notFound(path);
  }),

  // --- tracked (token credential) ---------------------------------------------------------------

  http.get(`${API}/tracked/issues`, ({ request }) => {
    const path = new URL(request.url).pathname;
    if (rejectUnexpectedBearer(request)) {
      return forbidden(path, '/tracked/** is authenticated by the tracking token, not a session.');
    }
    const token = request.headers.get('X-Tracking-Token');
    if (token !== MOCK_TRACKING_TOKEN) {
      return forbidden(path, 'A valid tracking token is required.');
    }
    return HttpResponse.json(issuePage([ISSUES[1]!]));
  }),

  http.get(`${API}/tracked/issues/:issueId`, ({ request, params }) => {
    const path = new URL(request.url).pathname;
    if (rejectUnexpectedBearer(request)) {
      return forbidden(path, '/tracked/** is authenticated by the tracking token, not a session.');
    }
    if (request.headers.get('X-Tracking-Token') !== MOCK_TRACKING_TOKEN) {
      return forbidden(path, 'A valid tracking token is required.');
    }
    if (TRACKED_ISSUE.id !== params['issueId']) {
      return notFound(path);
    }
    return HttpResponse.json(TRACKED_ISSUE);
  }),

  // --- public and reference (no credential) ----------------------------------------------------

  http.get(`${API}/public/issues/:publicCode`, ({ request, params }) => {
    const path = new URL(request.url).pathname;
    if (rejectUnexpectedBearer(request)) {
      return HttpResponse.json(
        envelope(400, 'VALIDATION_ERROR', 'This endpoint does not accept an Authorization header.', path),
        { status: 400 },
      );
    }
    if (params['publicCode'] !== PUBLIC_ISSUE.publicCode) {
      return notFound(path);
    }
    return HttpResponse.json(PUBLIC_ISSUE);
  }),

  // `/reference/**` is the opposite case to `/public/**`, and the difference is
  // easy to get wrong. The contract does *not* mark these operations
  // `security: []`, so they inherit the global bearer and a signed-in caller is
  // expected to send one. An earlier draft of this file rejected a bearer here
  // "to be safe", which 403'd every legitimate request - a mock that disagrees
  // with the contract is worse than no mock, because it teaches the UI to work
  // around a rule that does not exist.
  http.get(`${API}/reference/categories`, () => HttpResponse.json(CATEGORIES)),

  http.get(`${API}/reference/departments`, () =>
    HttpResponse.json([
      { id: 'dept-roads', name: 'Roads and Highways', active: true },
      { id: 'dept-parks', name: 'Parks and Open Spaces', active: true },
    ]),
  ),

  // --- notifications -----------------------------------------------------------------------------

  http.get(`${API}/notifications`, ({ request }) => {
    const path = new URL(request.url).pathname;
    const role = roleFromToken(request);
    if (!role) {
      return unauthenticated(path);
    }
    if (role === 'CITIZEN') {
      // SPEC 3.2: a concealed reporter has no account, so `/notifications` is
      // not where they hear about their report. Rejecting this is what stops a
      // future screen from quietly treating it as the concealed update channel.
      return forbidden(path, 'Concealed reporters are notified by email, not here.');
    }
    return HttpResponse.json(notificationPage(NOTIFICATIONS));
  }),

  http.post(`${API}/notifications/read-all`, ({ request }) => {
    const path = new URL(request.url).pathname;
    if (!roleFromToken(request)) {
      return unauthenticated(path);
    }
    return new HttpResponse(null, { status: 204 });
  }),

  // --- dashboard ----------------------------------------------------------------------------------

  http.get(`${API}/dashboard`, ({ request }) => {
    const path = new URL(request.url).pathname;
    const role = roleFromToken(request);
    if (!role) {
      return unauthenticated(path);
    }
    if (role !== 'DEPARTMENT_MANAGER' && role !== 'ADMIN') {
      return forbidden(path, 'The dashboard is for managers and admins.');
    }
    return HttpResponse.json({
      openIssues: 128,
      resolvedThisMonth: 46,
      breachesOpen: 3,
      awaitingConfirmation: 7,
      byStatus: {
        SUBMITTED: 4,
        AI_ANALYZING: 18,
        TRIAGED: 9,
        ASSIGNED: 12,
        IN_PROGRESS: 41,
        RESOLVED: 37,
        CLOSED: 214,
        REOPENED: 2,
        REJECTED: 5,
        DUPLICATE: 11,
        CANCELLED: 1,
      },
    });
  }),
];
