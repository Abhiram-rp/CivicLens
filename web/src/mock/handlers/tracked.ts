import { http, HttpResponse } from 'msw';
import type {
  CommentCreateRequest,
  IssueUpdateRequest,
  ReporterContact,
} from '../../app/api/generated/types.gen';
import { API, conflict, malformedBody, notFound, page, readJson, requireTrackingToken, validationError } from '../http';
import { asSummary, asTrackedComment, asTrackedDetail, commentsForIssue, visibleComments } from '../projections';
import { NOW, appendAudit, applyTransition, envelope, nextCommentId, state, type StoredIssue } from '../store';
import { tokenOwnsReport } from '../tracking';
import { evaluateTransition } from '../state-machine';

/**
 * The `/tracked/**` tree: a concealed reporter's only way back to their report.
 *
 * Every endpoint here carries `security: []` and is authenticated by
 * `X-Tracking-Token` alone. Two consequences shape the whole file:
 *
 * - **A session bearer is refused.** The tree's purpose is that a leaked tracking
 *   token is the *only* thing that opens it. Accepting a session too would mean a
 *   signed-in citizen could read reports they hold no token for, which is the whole
 *   guarantee the token exists to provide.
 * - **INTERNAL comments are filtered out.** SPEC calls this "the most damaging
 *   single bug this endpoint could have" - an internal note reaching a reporter. The
 *   filter lives in `visibleComments`, shared with the staff comment list, so there
 *   is one rule rather than two implementations that agree today.
 *
 * The lifecycle here is the *same* state machine the staff tree uses, and it writes
 * the same history rows and the same audit actions. SPEC requires that: only the
 * transport differs, never the lifecycle. A closed report from this file and one
 * closed via `/contact/decision` are indistinguishable downstream.
 */

/** The issue a token may reach, or the right refusal. */
function trackedIssue(request: Request, issueId: string): StoredIssue | Response {
  const path = new URL(request.url).pathname;
  const credential = requireTrackingToken(request);
  if (credential instanceof Response) {
    return credential;
  }
  const issue = state.issues.find((candidate) => candidate.id === issueId);
  // A token that does not own this id gets 404, not 403 - the resource exists but
  // the token cannot see it, and the status code must not confirm which ids are
  // real to a caller holding the wrong token.
  if (!issue || !tokenOwnsReport(credential.token, issueId)) {
    return notFound(path);
  }
  return issue;
}

export const trackedHandlers = [
  http.get(`${API}/tracked/issues`, ({ request }) => {
    const path = new URL(request.url).pathname;
    const credential = requireTrackingToken(request);
    if (credential instanceof Response) {
      return credential;
    }
    const ids = state.trackedTokens.get(credential.token) ?? [];
    // A list, because one token is a device and a device accumulates reports. This
    // used to return a single hard-coded report for a single hard-coded token, so a
    // token handed out by `POST /issues` reached nothing.
    //
    // Projected with `asSummary`, which is `IssueSummaryPage`'s element type and
    // carries no `reporterId`, no `address` and no coordinates - so the list is safe
    // by construction rather than by inspection. `asTrackedDetail` would also be
    // defensible here, but the list is a summary by contract and building the
    // summary twice is how the two shapes start to disagree.
    const reports = ids
      .map((id) => state.issues.find((issue) => issue.id === id))
      .filter((issue): issue is StoredIssue => issue !== undefined)
      .map((issue) => asSummary(issue));
    return HttpResponse.json(page(reports));
  }),

  http.get(`${API}/tracked/issues/:issueId`, ({ request, params }) => {
    const issue = trackedIssue(request, String(params['issueId']));
    return issue instanceof Response ? issue : HttpResponse.json(asTrackedDetail(issue));
  }),

  http.put(`${API}/tracked/issues/:issueId`, async ({ request, params }) => {
    const path = new URL(request.url).pathname;
    const issue = trackedIssue(request, String(params['issueId']));
    if (issue instanceof Response) {
      return issue;
    }

    // Same rule as the signed-in path: only while SUBMITTED or AI_ANALYZING. After
    // triage the report is an official record and is corrected through comments.
    if (!['SUBMITTED', 'AI_ANALYZING'].includes(issue.status)) {
      return conflict(path, 'An issue can only be edited while SUBMITTED or AI_ANALYZING.');
    }

    const body = await readJson<IssueUpdateRequest>(request);
    if (!body) {
      return malformedBody(path);
    }
    const problems: { field: string; issue: string }[] = [];
    if (typeof body.title === 'string' && (body.title.length < 5 || body.title.length > 200)) {
      problems.push({ field: 'title', issue: 'Must be between 5 and 200 characters.' });
    }
    if (typeof body.description === 'string' && (body.description.length < 10 || body.description.length > 5000)) {
      problems.push({ field: 'description', issue: 'Must be between 10 and 5000 characters.' });
    }
    const proposed = body.proposedCategoryText;
    if (typeof proposed === 'string' && (proposed.length < 3 || proposed.length > 100)) {
      problems.push({ field: 'proposedCategoryText', issue: 'Must be between 3 and 100 characters.' });
    }
    if (problems.length > 0) {
      return validationError(path, 'One or more fields are not valid.', problems);
    }

    const before = { title: issue.title, description: issue.description };
    if (typeof body.title === 'string') {
      issue.title = body.title;
    }
    if (typeof body.description === 'string') {
      issue.description = body.description;
    }
    if (typeof proposed === 'string' || proposed === null) {
      issue.proposedCategoryText = proposed ?? null;
    }
    issue.updatedAt = issue.now;

    appendAudit({
      actorId: null,
      // Attributed to the token rather than to a person. SPEC: a concealed
      // reporter has no account, and the token is never exposed.
      actorName: 'Concealed reporter',
      action: 'ISSUE_EDITED',
      entityType: 'Issue',
      entityId: issue.id,
      oldValue: before,
      newValue: { title: issue.title },
      concealed: true,
    });

    return HttpResponse.json(asTrackedDetail(issue));
  }),

  http.get(`${API}/tracked/issues/:issueId/comments`, ({ request, params }) => {
    const path = new URL(request.url).pathname;
    const issue = trackedIssue(request, String(params['issueId']));
    if (issue instanceof Response) {
      return issue;
    }
    const caller = { role: null, userId: null, displayName: 'concealed reporter', trackingToken: 'x', user: null };
    return HttpResponse.json(visibleComments(commentsForIssue(issue.id), caller, { asTracked: true }));  }),

  http.post(`${API}/tracked/issues/:issueId/comments`, async ({ request, params }) => {
    const path = new URL(request.url).pathname;
    const credential = requireTrackingToken(request);
    if (credential instanceof Response) {
      return credential;
    }
    const issue = state.issues.find((candidate) => candidate.id === String(params['issueId']));
    if (!issue || !tokenOwnsReport(credential.token, issue.id)) {
      return notFound(path);
    }

    const body = await readJson<CommentCreateRequest & { visibility?: string }>(request);
    if (!body) {
      return malformedBody(path);
    }
    if (!body.body || body.body.length < 1 || body.body.length > 5000) {
      return validationError(path, 'A comment body is required.', [
        { field: 'body', issue: 'Must be between 1 and 5000 characters.' },
      ]);
    }
    // Always PUBLIC - there is no role here for a server-decided INTERNAL to
    // contrast with, so the field is refused rather than ignored for the same
    // reason as on the staff tree.
    if (body.visibility !== undefined) {
      return validationError(path, 'Comment visibility is decided by the server.', [
        { field: 'visibility', issue: 'Not accepted from a client.' },
      ]);
    }

    const comment = {
      id: nextCommentId(),
      body: body.body,
      visibility: 'PUBLIC' as const,
      authorId: null,
      authorName: 'Concealed reporter',
      authorRole: 'CITIZEN' as const,
      concealedAuthor: true,
      createdAt: issue.now,
      editedAt: null,
      revisionCount: 0,
      // Null, always: the caller is the token, not a user, so there is no author to
      // edit as and no button to offer. Computing a window here would either show
      // an action that always 422s or hide one a real author could have used.
      editWindowEndsAt: null,
      deletedAt: null,
      concealedByToken: credential.token,
      revisions: [],
      issueId: issue.id,
    };
    state.comments.push(comment);

    appendAudit({
      actorId: null,
      actorName: 'Concealed reporter',
      action: 'COMMENT_ADDED',
      entityType: 'Issue',
      entityId: issue.id,
      newValue: { commentId: comment.id, visibility: 'PUBLIC' },
      concealed: true,
    });

    return HttpResponse.json(asTrackedComment(comment), { status: 201 });
  }),

  http.post(`${API}/tracked/issues/:issueId/confirm`, ({ request, params }) => {
    const path = new URL(request.url).pathname;
    const issue = trackedIssue(request, String(params['issueId']));
    if (issue instanceof Response) {
      return issue;
    }

    // The concealed counterpart of `POST /issues/{id}/confirm`, and the only way a
    // concealed report ever reaches CLOSED. A concealed reporter who is satisfied
    // closes their own report; nobody closes it for them.
    // `role: 'CITIZEN'`, not null: concealment changes who can *see* the reporter,
// never what they may do. A concealed reporter is a reporter, so the same
// reporter-owned edges apply. Passing null here made every tracked transition
// unreachable, because the machine refuses a null role before it ever looks at
// `isReporter` - which silently killed both `/confirm` and `/reopen`.
    const verdict = evaluateTransition(issue.status, 'CLOSED', { role: 'CITIZEN', userId: null, displayName: 'concealed reporter' }, { isReporter: true });
    if (!verdict.allowed) {
      return conflict(path, verdict.reason);
    }

    issue.confirmationCount += 1;
    applyTransition(issue, 'CLOSED', { userId: null, displayName: 'Concealed reporter' }, 'Reporter confirmed the fix.');
    appendAudit({
      actorId: null,
      actorName: 'Concealed reporter',
      action: 'ISSUE_CLOSED',
      entityType: 'Issue',
      entityId: issue.id,
      concealed: true,
    });

    return HttpResponse.json(asTrackedDetail(issue));
  }),

  http.post(`${API}/tracked/issues/:issueId/reopen`, async ({ request, params }) => {
    const path = new URL(request.url).pathname;
    const issue = trackedIssue(request, String(params['issueId']));
    if (issue instanceof Response) {
      return issue;
    }
    const body = await readJson<{ reason?: string }>(request);
    if (!body) {
      return malformedBody(path);
    }
    if (!body.reason || body.reason.length < 10 || body.reason.length > 1000) {
      return validationError(path, 'A reason is required.', [
        { field: 'reason', issue: 'Must be between 10 and 1000 characters.' },
      ]);
    }

    // Same 14-day window as the signed-in path. An expired window is 422 with its
    // own code, not 409: the window is a fact about the calendar, not about the
    // current status.
    if (issue.reopenWindowEndsAt && Date.parse(issue.now) > Date.parse(issue.reopenWindowEndsAt)) {
      return HttpResponse.json(
        envelope(422, 'REOPEN_WINDOW_EXPIRED', 'The reopen window for this fix has closed.', path),
        { status: 422 },
      );
    }

    const verdict = evaluateTransition(issue.status, 'REOPENED', { role: 'CITIZEN', userId: null, displayName: 'concealed reporter' }, { isReporter: true });
    if (!verdict.allowed) {
      return conflict(path, verdict.reason);
    }

    applyTransition(issue, 'REOPENED', { userId: null, displayName: 'Concealed reporter' }, body.reason);
    appendAudit({
      actorId: null,
      actorName: 'Concealed reporter',
      action: 'ISSUE_REOPENED',
      entityType: 'Issue',
      entityId: issue.id,
      newValue: { reason: body.reason },
      concealed: true,
    });

    return HttpResponse.json(asTrackedDetail(issue));
  }),

  http.post(`${API}/tracked/issues/:issueId/reveal`, async ({ request, params }) => {
    const path = new URL(request.url).pathname;
    const issue = trackedIssue(request, String(params['issueId']));
    if (issue instanceof Response) {
      return issue;
    }
    const body = await readJson<ReporterContact & { contactDisclosureNote?: string }>(request);
    if (!body) {
      return malformedBody(path);
    }
    if (body.type !== 'EMAIL' || !body.value) {
      return validationError(path, 'A contact channel is required.', [
        { field: 'value', issue: 'Must be an EMAIL contact.' },
      ]);
    }
    if (body.contactDisclosureNote !== '1') {
      return validationError(path, 'The disclosure note is required.', [
        { field: 'contactDisclosureNote', issue: 'Must be the marker "1".' },
      ]);
    }

    // 409 for both "already shared" and "a reveal is already in flight", because
    // neither is a validation problem - the request was well formed, the state is
    // wrong. SPEC groups them.
    if (issue.disclosure === 'SHARE_DETAILS') {
      return conflict(path, 'This report is already shared with the reporter\'s details.');
    }
    if (issue.revealRequested) {
      return conflict(path, 'A reveal is already in flight for this report.');
    }

    // 202: the contact is *being verified*, and the issue stays concealed - and out
    // of every queue - until it succeeds. A leaked tracking token must not be enough
    // to deconceal a report, or the concealment guarantee would rest on the secrecy
    // of a token that travels in URLs.
    issue.revealRequested = true;
    issue.contactEmail = body.value;
    issue.contactState = 'PENDING_VERIFICATION';

    appendAudit({
      actorId: null,
      actorName: 'Concealed reporter',
      action: 'ISSUE_REVEAL_REQUESTED',
      entityType: 'Issue',
      entityId: issue.id,
      newValue: { contactType: 'EMAIL' },
      concealed: true,
    });

    return HttpResponse.json(asTrackedDetail(issue), { status: 202 });
  }),
];
