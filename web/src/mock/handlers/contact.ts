import { http, HttpResponse } from 'msw';
import { API, malformedBody, notFound, readJson, validationError } from '../http';
import { NOW, applyTransition, envelope, state } from '../store';
import { evaluateTransition } from '../state-machine';
import { asSummary } from '../projections';

/**
 * `/contact/**`: the two halves of the double opt-in that a concealed report
 * depends on.
 *
 * ## Why this is the most important pair in the mock
 *
 * A concealed reporter has no account, so `/notifications` is not where they hear
 * anything and `/tracked/**` needs a token that is returned exactly once. Email is
 * the only channel that reaches them, which makes these two endpoints the *only*
 * way the lifecycle advances for a concealed report:
 *
 * - `POST /contact/verify` completes double opt-in. Until it succeeds the report is
 *   `PENDING_VERIFICATION` and is held out of every triage, assignment and SLA
 *   queue. That gate is what stops the contact channel being used to make a
 *   stranger receive mail about a problem they never reported.
 * - `POST /contact/decision` is the approval gate. An officer's resolve *proposes*;
 *   nothing is `CLOSED` until the reporter answers, and the answer may be
 *   `DISPUTE`, which sends the report to `REOPENED` with the reason attached.
 *
 * **This gate is the same for every reporter.** Concealment changes who can *see*
 * the reporter, never the lifecycle. So this file drives the same state machine as
 * `/tracked/**`, writes the same history rows and the same audit actions, and only
 * the transport differs - which is what makes a concealed report's lifecycle
 * testable against the same assertions as a shared one.
 *
 * ## The token is a `Map` key, not a magic constant
 *
 * The real token arrives in an email. There is no inbox in a development mock, so
 * `seed.ts` publishes the well-known tokens as constants. Modelling them as
 * single-use, expiring records rather than as a magic string is what lets the whole
 * flow be tested: `410` on a second use, and on an expired token, are the two
 * failure modes that would otherwise be untestable.
 */

/** The token from the query string or the body. */
function decisionToken(request: Request, body: Record<string, unknown> | null): string | null {
  const fromQuery = new URL(request.url).searchParams.get('decisionToken');
  if (fromQuery) {
    return fromQuery;
  }
  const fromBody = body?.['decisionToken'];
  return typeof fromBody === 'string' ? fromBody : null;
}

export const contactHandlers = [
  http.post(`${API}/contact/verify`, async ({ request }) => {
    const path = new URL(request.url).pathname;
    const body = await readJson<{ token?: string }>(request);
    if (!body) {
      return malformedBody(path);
    }
    const token = body.token ?? new URL(request.url).searchParams.get('token');
    if (!token) {
      return validationError(path, 'A verification token is required.', [
        { field: 'token', issue: 'Required.' },
      ]);
    }

    const record = state.verificationTokens.get(token);
    if (!record) {
      // 404 rather than 410: no such token. A 410 is for a token that existed.
      return notFound(path, 'No such verification token.');
    }
    // 410 for both already-used and expired. The contract groups them, and the
    // grouping is the point: after a verification link has been followed once, the
    // link is dead *forever*, so a second click on the same email must not
    // re-verify anything - and the reporter's most likely action is to click it
    // twice.
    if (record.used) {
      return HttpResponse.json(
        envelope(410, 'VALIDATION_ERROR', 'This verification link has already been used.', path),
        { status: 410 },
      );
    }
    if (Date.parse(NOW) > Date.parse(record.expiresAt)) {
      return HttpResponse.json(
        envelope(410, 'VALIDATION_ERROR', 'This verification link has expired.', path),
        { status: 410 },
      );
    }

    const issue = state.issues.find((candidate) => candidate.id === record.issueId);
    if (!issue) {
      return notFound(path, 'No such report.');
    }

    record.used = true;
    // The single transition that moves a concealed report out of the hold. Note it
    // does not change `status` - the report is still SUBMITTED and still awaiting
    // triage - it changes `contactState`, which is the routing fact.
    issue.contactState = 'VERIFIED';
    issue.updatedAt = issue.now;

    state.auditLogs.unshift({
      id: `aud-verify-${issue.id}`,
      actorId: null,
      actorName: 'Concealed reporter',
      action: 'CONTACT_VERIFIED',
      entityType: 'Issue',
      entityId: issue.id,
      oldValue: { contactState: 'PENDING_VERIFICATION' },
      newValue: { contactState: 'VERIFIED' },
      ipAddress: null,
      createdAt: issue.now,
    });

    return new HttpResponse(null, { status: 204 });
  }),

  http.post(`${API}/contact/decision`, async ({ request }) => {
    const path = new URL(request.url).pathname;
    const body = await readJson<Record<string, unknown>>(request);
    if (!body) {
      return malformedBody(path);
    }

    const token = decisionToken(request, body);
    if (!token) {
      return validationError(path, 'A decision token is required.', [
        { field: 'decisionToken', issue: 'Required.' },
      ]);
    }
    const decision = body['decision'];
    if (decision !== 'APPROVE' && decision !== 'DISPUTE') {
      return validationError(path, 'A decision is required.', [
        { field: 'decision', issue: 'Must be APPROVE or DISPUTE.' },
      ]);
    }
    // A dispute without a reason leaves the officer nothing to act on. Required
    // against DISPUTE only, and ignored otherwise - the contract says exactly that.
    const reason = typeof body['reason'] === 'string' ? body['reason'] : '';
    if (decision === 'DISPUTE' && (reason.length < 10 || reason.length > 1000)) {
      return validationError(path, 'A dispute needs a reason.', [
        { field: 'reason', issue: 'Must be between 10 and 1000 characters when disputing.' },
      ]);
    }

    const record = state.decisionTokens.get(token);
    if (!record) {
      return notFound(path, 'No such decision token.');
    }
    if (record.used) {
      return HttpResponse.json(
        envelope(410, 'VALIDATION_ERROR', 'This decision link has already been used.', path),
        { status: 410 },
      );
    }
    if (Date.parse(NOW) > Date.parse(record.expiresAt)) {
      return HttpResponse.json(
        envelope(410, 'VALIDATION_ERROR', 'This decision link has expired.', path),
        { status: 410 },
      );
    }

    const issue = state.issues.find((candidate) => candidate.id === record.issueId);
    if (!issue) {
      return notFound(path, 'No such report.');
    }
    // 409, not 422: the report is not awaiting a decision, which is a state
    // problem rather than an expiry problem. A reporter who clicks the link twice
    // with two different answers is exactly the case this covers.
    if (issue.status !== 'RESOLVED') {
      return HttpResponse.json(
        envelope(409, 'INVALID_STATE_TRANSITION', 'The report is no longer awaiting a decision.', path),
        { status: 409 },
      );
    }

    record.used = true;
    const actor = { userId: null, displayName: 'Reporter' };
    const target = decision === 'APPROVE' ? 'CLOSED' : 'REOPENED';

    // The same machine, so a concealed report's disposition is decided by exactly
    // the same rules as a shared one. Only the transport differs.
    const verdict = evaluateTransition(issue.status, target, { role: 'CITIZEN', ...actor }, { isReporter: true });
    if (!verdict.allowed) {
      return HttpResponse.json(
        envelope(409, 'INVALID_STATE_TRANSITION', verdict.reason, path),
        { status: 409 },
      );
    }

    if (decision === 'APPROVE') {
      issue.confirmationCount += 1;
    }
    applyTransition(issue, target, actor, decision === 'DISPUTE' ? reason : 'Reporter approved the fix.');

    state.auditLogs.unshift({
      id: `aud-decision-${issue.id}`,
      actorId: null,
      actorName: 'Reporter',
      action: decision === 'APPROVE' ? 'ISSUE_CLOSED' : 'ISSUE_REOPENED',
      entityType: 'Issue',
      entityId: issue.id,
      oldValue: { status: 'RESOLVED' },
      newValue: { status: target, decision },
      ipAddress: null,
      createdAt: issue.now,
    });

    return HttpResponse.json(asSummary(issue));
  }),
];
