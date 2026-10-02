import { setupServer } from 'msw/node';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { handlers } from './handlers';
import { resetMockState } from './seed';

const server = setupServer(...handlers);
const API = 'http://localhost:8080/api/v1';

const ADMIN = { Authorization: 'Bearer mock-token-ADMIN' };
const MANAGER = { Authorization: 'Bearer mock-token-DEPARTMENT_MANAGER' };
const CITIZEN = { Authorization: 'Bearer mock-token-CITIZEN' };
const OFFICER = { Authorization: 'Bearer mock-token-FIELD_OFFICER' };
const TRACKING = { 'X-Tracking-Token': 'civiclens-mock-tracking-token-do-not-use' };
const JSON_HEADERS = { 'Content-Type': 'application/json' };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

type Step = [
  operationId: string,
  url: string | ((c: Record<string, string>) => string),
  init?: RequestInit & { capture?: 'issueId' | 'commentId' },
];

/** Ids captured from responses, so later steps in the same block can address them. */
const captured: Record<string, string> = {};

/**
 * Runs each step against a freshly reset mock and asserts every one answers 2xx.
 *
 * ## Why one call per operation is not enough on its own
 *
 * Registering a handler and exercising it are different claims. The coverage gate in
 * `check-generated-api.mjs` proves every route is registered; this proves each one
 * actually answers. The two found bugs this file was written for are both cases where
 * registration passed and behaviour did not: `/reference/**` refused every legitimate
 * caller, and both tracked-reporter transitions were unreachable because the concealed
 * actor was passed to the state machine with a null role.
 *
 * ## Why every block gets its own reset
 *
 * These operations are deliberately stateful, and several are mutually exclusive
 * terminal transitions on the same seeded row (confirm vs reject a duplicate, close vs
 * reopen). A single shared sequence would let one call's outcome decide a later call's
 * result, which is exactly the class of false pass this is meant to rule out. Anything a
 * block needs must be created inside that block, which is what `capture` is for.
 */
async function expectAllSucceed(steps: Step[]): Promise<void> {
  resetMockState();
  for (const key of Object.keys(captured)) {
    delete captured[key];
  }

  const failures: string[] = [];
  for (const [operationId, url, init] of steps) {
    const target = typeof url === 'function' ? url(captured) : url;
    const res = await fetch(target, init);
    const ok = res.status >= 200 && res.status < 300;

    if (ok && init?.capture) {
      const json = (await res.json()) as { issue?: { id?: string }; id?: string };
      captured[init.capture] = json.issue?.id ?? json.id ?? '';
    }
    if (!ok) {
      // The envelope carries the contract's own code and message, which is what makes a
      // failure diagnosable without re-running.
      failures.push(`${operationId} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  }

  expect(failures, `operations that did not answer 2xx:\n${failures.join('\n')}`).toEqual([]);
}

/**
 * The multipart body `POST /issues` requires. `disclosure` is `SHARE_DETAILS |
 * CONCEALED`, and a signed-in citizen reporting SHARE_DETAILS must NOT send contact
 * details, because the server already has their account and rejects the combination.
 */
function createForm(): FormData {
  const form = new FormData();
  form.set('title', 'Test created report');
  form.set('description', 'Created by the contract walk to reach a legal state.');
  form.set('disclosure', 'SHARE_DETAILS');
  form.set('latitude', '51.5074');
  form.set('longitude', '-0.1278');
  return form;
}

describe('every contract operation answers', () => {
  it('serves the read-only and list endpoints', async () => {
    await expectAllSucceed([
      ['getDashboard', `${API}/dashboard`, { headers: ADMIN }],
      ['listNotifications', `${API}/notifications`, { headers: ADMIN }],
      ['markNotificationRead', `${API}/notifications/ntf-1/read`, { method: 'POST', headers: ADMIN }],
      ['markAllNotificationsRead', `${API}/notifications/read-all`, { method: 'POST', headers: ADMIN }],
      // `security: []` on both: an anonymous call is the legitimate one, and sending a
      // bearer is the caller's bug, which the endpoint answers with a 400.
      ['listReferenceCategories', `${API}/reference/categories`],
      ['listReferenceDepartments', `${API}/reference/departments`],
      ['getPublicIssue', `${API}/public/issues/CL-2026-0001`],
      ['listIssues', `${API}/issues`, { headers: MANAGER }],
      ['listMyIssues', `${API}/issues/mine`, { headers: CITIZEN }],
      ['getIssue', `${API}/issues/iss-shared-1`, { headers: MANAGER }],
      ['listComments', `${API}/issues/iss-shared-1/comments`, { headers: MANAGER }],
      ['listCommentRevisions', `${API}/issues/iss-shared-1/comments/cmt-1/revisions`, { headers: MANAGER }],
      ['listDuplicates', `${API}/issues/iss-shared-2/duplicates`, { headers: MANAGER }],
    ]);
  });

  it('serves authentication and device registration', async () => {
    await expectAllSucceed([
      ['login', `${API}/auth/login`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ email: 'admin@civiclens.example.org', password: 'mock-password-do-not-use', clientType: 'WEB' }) }],
      ['register', `${API}/auth/register`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ email: 'contract-walk@example.org', password: 'x'.repeat(12), fullName: 'Contract Walk' }) }],
      ['refreshToken', `${API}/auth/refresh`, { method: 'POST', headers: { Cookie: 'civiclens_refresh=x' } }],
      ['logout', `${API}/auth/logout`, { method: 'POST', headers: ADMIN }],
      // The body is `{ token, platform }`: the push token IS the device token.
      ['registerDevice', `${API}/devices/register`, { method: 'POST', headers: { ...ADMIN, ...JSON_HEADERS }, body: JSON.stringify({ token: 'push-token-contract-walk', platform: 'ANDROID' }) }],
      ['unregisterDevice', `${API}/devices/unregister`, { method: 'POST', headers: { ...ADMIN, ...JSON_HEADERS }, body: JSON.stringify({ token: 'push-token-contract-walk' }) }],
    ]);
  });

  it('lets a citizen create a report and edit it inside the edit window', async () => {
    // `updateIssue` is CITIZEN-only and legal only while SUBMITTED/AI_ANALYZING, and no
    // seeded report is in that state, so the created one is the only route. There is no
    // forward walk from here: SUBMITTED has no outbound edge, because the triage hop
    // (SUBMITTED -> AI_ANALYZING -> TRIAGED) is system-driven and the contract exposes
    // no operation that performs it.
    await expectAllSucceed([
      ['createIssue', `${API}/issues`, { method: 'POST', headers: { ...CITIZEN, 'Idempotency-Key': '22222222-2222-4222-8222-222222222222' }, body: createForm(), capture: 'issueId' }],
      ['updateIssue', (c) => `${API}/issues/${c['issueId']}`, { method: 'PUT', headers: { ...CITIZEN, ...JSON_HEADERS }, body: JSON.stringify({ title: 'Renamed by contract walk' }) }],
    ]);
  });

  it('walks the whole reporter-visible lifecycle', async () => {
    // A created report cannot leave SUBMITTED, so the walk uses the seeded IN_PROGRESS
    // one: resolve -> CLOSED -> REOPENED -> ASSIGNED -> TRIAGED. Each hop is the only
    // legal edge out of the status the previous hop produced.
    await expectAllSucceed([
      // FIELD_OFFICER-only and assignee-only; usr-officer-1 is the seeded assignee.
      ['resolveIssue', `${API}/issues/iss-shared-1/resolve`, { method: 'POST', headers: { ...OFFICER, ...JSON_HEADERS }, body: JSON.stringify({ notes: 'Pothole filled and the surface regraded.' }) }],
      ['confirmResolution', `${API}/issues/iss-shared-1/confirm`, { method: 'POST', headers: { ...CITIZEN, ...JSON_HEADERS }, body: JSON.stringify({ rating: 5 }) }],
      ['reopenIssue', `${API}/issues/iss-shared-1/reopen`, { method: 'POST', headers: { ...CITIZEN, ...JSON_HEADERS }, body: JSON.stringify({ reason: 'The patch has already failed again.' }) }],
      ['transitionIssue', `${API}/issues/iss-shared-1/transition`, { method: 'POST', headers: { ...MANAGER, ...JSON_HEADERS }, body: JSON.stringify({ targetStatus: 'ASSIGNED' }) }],
      // A manager can pull an assignment back to TRIAGED for reassignment, and
      // `assignIssue` is only legal from TRIAGED - this is the route to it.
      ['transitionIssue', `${API}/issues/iss-shared-1/transition`, { method: 'POST', headers: { ...MANAGER, ...JSON_HEADERS }, body: JSON.stringify({ targetStatus: 'TRIAGED' }) }],
      ['assignIssue', `${API}/issues/iss-shared-1/assign`, { method: 'POST', headers: { ...MANAGER, ...JSON_HEADERS }, body: JSON.stringify({ officerId: 'usr-officer-1' }) }],
    ]);
  });

  it('applies a staff status change with a reason', async () => {
    // `ASSIGNED -> IN_PROGRESS` is assignee-only, and both `/status` and `/transition`
    // declare `x-required-roles: [DEPARTMENT_MANAGER, ADMIN]`, so no operation in the
    // contract can perform it. `changeIssueStatus` is reached on the staff-only
    // `RESOLVED -> IN_PROGRESS` edge instead, which requires a reason.
    await expectAllSucceed([
      ['changeIssueStatus', `${API}/issues/iss-shared-2/status`, { method: 'POST', headers: { ...MANAGER, ...JSON_HEADERS }, body: JSON.stringify({ targetStatus: 'IN_PROGRESS', reason: 'The light has come back on twice this week.' }) }],
    ]);
  });

  it('reopens a report that is RESOLVED but not yet closed', async () => {
    await expectAllSucceed([
      ['reopenIssue', `${API}/issues/iss-shared-2/reopen`, { method: 'POST', headers: { ...CITIZEN, ...JSON_HEADERS }, body: JSON.stringify({ reason: 'The streetlight is still out.' }) }],
    ]);
  });

  it('edits and deletes a comment inside its edit window', async () => {
    // The window is 15 minutes and every seeded comment is older than that, so the
    // comment created here is the only one that can legally be edited or deleted.
    await expectAllSucceed([
      ['addComment', `${API}/issues/iss-shared-1/comments`, { method: 'POST', headers: { ...MANAGER, ...JSON_HEADERS }, body: JSON.stringify({ body: 'Contract walk comment' }), capture: 'commentId' }],
      ['updateComment', (c) => `${API}/issues/iss-shared-1/comments/${c['commentId']}`, { method: 'PUT', headers: { ...MANAGER, ...JSON_HEADERS }, body: JSON.stringify({ body: 'Edited by contract walk' }) }],
      ['listCommentRevisions', (c) => `${API}/issues/iss-shared-1/comments/${c['commentId']}/revisions`, { headers: MANAGER }],
      ['deleteComment', (c) => `${API}/issues/iss-shared-1/comments/${c['commentId']}`, { method: 'DELETE', headers: MANAGER }],
    ]);
  });

  it('confirms one duplicate match and rejects another', async () => {
    // Separate blocks because the two are mutually exclusive terminal states on the
    // same seeded row, and one call would decide the other's outcome.
    await expectAllSucceed([['confirmDuplicate', `${API}/duplicates/dup-1/confirm`, { method: 'POST', headers: ADMIN }]]);
    await expectAllSucceed([['rejectDuplicate', `${API}/duplicates/dup-1/reject`, { method: 'POST', headers: ADMIN }]]);
  });

  it('serves every admin operation', async () => {
    await expectAllSucceed([
      ['listUsers', `${API}/admin/users`, { headers: ADMIN }],
      ['createUser', `${API}/admin/users`, { method: 'POST', headers: { ...ADMIN, ...JSON_HEADERS }, body: JSON.stringify({ email: 'contract-walk-officer@example.org', password: 'x'.repeat(12), fullName: 'Contract Walk Officer', role: 'FIELD_OFFICER', departmentId: 'dept-roads' }) }],
      ['changeUserRole', `${API}/admin/users/usr-officer-1/role`, { method: 'PUT', headers: { ...ADMIN, ...JSON_HEADERS }, body: JSON.stringify({ role: 'FIELD_OFFICER' }) }],
      ['changeUserStatus', `${API}/admin/users/usr-officer-1/status`, { method: 'PUT', headers: { ...ADMIN, ...JSON_HEADERS }, body: JSON.stringify({ status: 'ACTIVE' }) }],
      ['listDepartments', `${API}/admin/departments`, { headers: ADMIN }],
      ['createDepartment', `${API}/admin/departments`, { method: 'POST', headers: { ...ADMIN, ...JSON_HEADERS }, body: JSON.stringify({ name: 'Contract Walk Dept', code: 'CWD' }) }],
      ['updateDepartment', `${API}/admin/departments/dept-roads`, { method: 'PUT', headers: { ...ADMIN, ...JSON_HEADERS }, body: JSON.stringify({ name: 'Roads', code: 'ROADS' }) }],
      ['listCategories', `${API}/admin/categories`, { headers: ADMIN }],
      ['createCategory', `${API}/admin/categories`, { method: 'POST', headers: { ...ADMIN, ...JSON_HEADERS }, body: JSON.stringify({ name: 'Contract Walk Cat', code: 'CWC' }) }],
      ['updateCategory', `${API}/admin/categories/cat-roads`, { method: 'PUT', headers: { ...ADMIN, ...JSON_HEADERS }, body: JSON.stringify({ name: 'Roads', code: 'ROADS' }) }],
      ['listSlaPolicies', `${API}/admin/sla-policies`, { headers: ADMIN }],
      ['upsertSlaPolicy', `${API}/admin/sla-policies`, { method: 'PUT', headers: { ...ADMIN, ...JSON_HEADERS }, body: JSON.stringify({ priority: 'HIGH', resolveWithinHours: 48, reason: 'contract walk' }) }],
      ['listAuditLogs', `${API}/admin/audit-logs`, { headers: ADMIN }],
      ['exportIssues', `${API}/admin/export/issues.csv`, { headers: ADMIN }],
    ]);
  });

  it('serves the tracked tree and both halves of double opt-in', async () => {
    await expectAllSucceed([
      ['listTrackedIssues', `${API}/tracked/issues`, { headers: TRACKING }],
      ['getTrackedIssue', `${API}/tracked/issues/iss-concealed-1`, { headers: TRACKING }],
      ['updateTrackedIssue', `${API}/tracked/issues/iss-concealed-1`, { method: 'PUT', headers: { ...TRACKING, ...JSON_HEADERS }, body: JSON.stringify({ title: 'Renamed by contract walk' }) }],
      ['listTrackedComments', `${API}/tracked/issues/iss-concealed-1/comments`, { headers: TRACKING }],
      ['addTrackedComment', `${API}/tracked/issues/iss-concealed-1/comments`, { method: 'POST', headers: { ...TRACKING, ...JSON_HEADERS }, body: JSON.stringify({ body: 'Contract walk' }) }],
      // Needs the EMAIL channel plus the `contactDisclosureNote` marker, and answers 202:
      // the contact is being verified and the report stays concealed until it succeeds.
      ['revealTrackedIssue', `${API}/tracked/issues/iss-concealed-1/reveal`, { method: 'POST', headers: { ...TRACKING, ...JSON_HEADERS }, body: JSON.stringify({ type: 'EMAIL', value: 'contract-walk@example.org', contactDisclosureNote: '1' }) }],
      ['verifyContact', `${API}/contact/verify`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token: 'civiclens-mock-verify-token-do-not-use' }) }],
    ]);
  });

  it('closes a report through the contact decision gate', async () => {
    // The decision token is bound to iss-shared-2, which is seeded RESOLVED.
    await expectAllSucceed([
      ['submitContactDecision', `${API}/contact/decision`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ decisionToken: 'civiclens-mock-decision-token-do-not-use', decision: 'APPROVE' }) }],
    ]);
  });

  it('lets a concealed reporter close and dispute their own report', async () => {
    // Both need a RESOLVED report, which is why the seed carries a concealed report in
    // that state alongside the AI_ANALYZING one. Concealment changes who can *see* the
    // reporter, never what the reporter may do.
    await expectAllSucceed([
      ['confirmTrackedResolution', `${API}/tracked/issues/iss-concealed-resolved/confirm`, { method: 'POST', headers: { ...TRACKING, ...JSON_HEADERS }, body: JSON.stringify({ rating: 5 }) }],
    ]);
    await expectAllSucceed([
      ['reopenTrackedIssue', `${API}/tracked/issues/iss-concealed-resolved/reopen`, { method: 'POST', headers: { ...TRACKING, ...JSON_HEADERS }, body: JSON.stringify({ reason: 'The alley is still dark after nine.' }) }],
    ]);
  });
});
