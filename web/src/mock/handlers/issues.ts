import { http, HttpResponse, type HttpResponseResolver, type PathParams } from 'msw';
import type {
  CommentCreateRequest,
  IssueUpdateRequest,
} from '../../app/api/generated/types.gen';
import {
  API,
  canSeeIssue,
  conflict,
  forbidden,
  isReporter,
  isStaffInScope,
  malformedBody,
  notFound,
  page,
  readJson,
  rejectUnexpectedBearer,
  requireRole,
  resolveCaller,
  trackedIssueFor,
  unauthenticated,
  validationError,
} from '../http';
import {
  asComment,
  asStaffDetail,
  asSummary,
  asTrackedDetail,
  canSeeComment,
  commentsForIssue,
  visibleComments,
} from '../projections';
import {
  NOW,
  appendAudit,
  applyTransition,
  editWindowEndsAt,
  envelope,
  nextCommentId,
  nextRevisionId,
  state,
  type StoredComment,
  type StoredIssue,
} from '../store';
import { evaluateTransition } from '../state-machine';
import { createIssueReport } from './create-issue';
import type { Caller } from '../http';

/**
 * The `/issues/**` staff tree: detail, comments, and the lifecycle.
 *
 * Everything here routes through two shared decisions so they cannot drift:
 *
 * - `evaluateTransition` for every status change. SPEC calls the state machine "the
 *   highest-value test suite in the project" precisely because controllers must not
 *   set status directly; a mock that hand-wrote `issue.status = 'RESOLVED'` would
 *   model the thing SPEC forbids.
 * - `projections.ts` for every response. A staff read and a reporter's read of one
 *   row produce two different documents, and the fields that differ are the
 *   sensitive ones.
 */

/** Resolve a path parameter to an issue the caller may see, or the right refusal. */
function visibleIssue(caller: Caller, issueId: string, path: string): StoredIssue | Response {
  const issue = state.issues.find((candidate) => candidate.id === issueId);
  // One response for "no such issue" and "not visible to you", deliberately
  // indistinguishable. A 403 here would confirm the report exists to a caller who
  // cannot see it, which is the enumeration the 404-not-403 rule exists to stop.
  if (!issue || !canSeeIssue(caller, issue)) {
    return notFound(path);
  }
  return issue;
}

/** Resolve a path parameter for a staff-only operation. */
function staffIssue(
  caller: Caller,
  issueId: string,
  path: string,
  roles: readonly ('FIELD_OFFICER' | 'DEPARTMENT_MANAGER' | 'ADMIN')[],
): StoredIssue | Response {
  const denied = requireRole(caller, roles, path);
  if (denied) {
    return denied;
  }
  return visibleIssue(caller, issueId, path);
}

/**
 * The 30-minute comment edit window.
 *
 * `COMMENT_EDIT_WINDOW_MINUTES` is 30. Past it an official record should not be
 * quietly rewritten after people have stopped expecting it to change - the same
 * reasoning as `/reopen`'s window, and the reason this is a 422 with its own code
 * rather than a 403. A 403 would say "you may never", when the truth is "you
 * could, and the window has closed".
 */
function editWindowResponse(comment: StoredComment, now: string, caller: Caller, path: string): Response | null {
  const isAuthor = comment.authorId !== null && comment.authorId === caller.userId;
  if (!isAuthor) {
    return HttpResponse.json(
      envelope(422, 'COMMENT_EDIT_WINDOW_EXPIRED', 'Only the author may edit this comment.', path),
      { status: 422 },
    );
  }
  const ends = comment.editWindowEndsAt ?? editWindowEndsAt(comment, comment.createdAt, true);
  if (ends === null || Date.parse(now) > Date.parse(ends)) {
    return HttpResponse.json(
      envelope(422, 'COMMENT_EDIT_WINDOW_EXPIRED', 'The edit window for this comment has closed.', path),
      { status: 422 },
    );
  }
  return null;
}

/** `POST /issues` - multipart, idempotent, and the only place a token is minted. */
const createIssueHandler = http.post(`${API}/issues`, async ({ request }) => {
  const path = new URL(request.url).pathname;
  const form = await request.formData();
  const caller = resolveCaller(request);
  return createIssueReport({ request, form, caller, path });
});
export const issueHandlers = [
  createIssueHandler,

  http.get(`${API}/issues`, ({ request }) => {
    const path = new URL(request.url).pathname;
    const caller = resolveCaller(request);
    const denied = requireRole(caller, ['FIELD_OFFICER', 'DEPARTMENT_MANAGER', 'ADMIN'], path);
    if (denied) {
      return denied;
    }
    const url = new URL(request.url);
    const scope = url.searchParams.get('scope');
    const staleOnly = url.searchParams.get('staleResolvedOnly') === 'true';

    let visible = state.issues.filter((issue) => canSeeIssue(caller, issue));

    // `staleResolvedOnly` is SPEC's non-destructive replacement for auto-close: a
    // manager chases the citizen, and nothing closes on a timer. A mock ignoring
    // the filter would let a queue screen build against an empty result and then
    // show 200 reports in production.
    if (staleOnly) {
      visible = visible.filter((issue) => issue.status === 'RESOLVED' && issue.closedAt === null);
    } else if (scope === 'open') {
      visible = visible.filter((issue) => !['CLOSED', 'REJECTED', 'DUPLICATE', 'CANCELLED'].includes(issue.status));
    }

    return HttpResponse.json(page(visible.map(asSummary)));
  }),

  http.get(`${API}/issues/mine`, ({ request }) => {
    const path = new URL(request.url).pathname;
    const caller = resolveCaller(request);
    if (!caller.userId) {
      return unauthenticated(path);
    }
    // The reporter's own reports, and only their own. A mock falling back to "all
    // issues" would make a citizen's report list render other people's reports,
    // which is the most damaging thing this endpoint could do.
    return HttpResponse.json(page(state.issues.filter((issue) => isReporter(caller, issue)).map(asSummary)));
  }),

  http.get(`${API}/issues/:issueId`, ({ request, params }) => {
    const path = new URL(request.url).pathname;
    const caller = resolveCaller(request);
    const denied = requireRole(caller, ['CITIZEN', 'FIELD_OFFICER', 'DEPARTMENT_MANAGER', 'ADMIN'], path);
    if (denied) {
      return denied;
    }
    const issue = visibleIssue(caller, String(params['issueId']), path);
    if (issue instanceof Response) {
      return issue;
    }
    // A citizen reading their own report gets the tracked projection - no
    // coordinates, no reporter block, no officer id - rather than the staff one,
    // so they cannot see an internal field by reading their own report.
    if (caller.role === 'CITIZEN' || isReporter(caller, issue)) {
      return HttpResponse.json(asTrackedDetail(issue));
    }
    return HttpResponse.json(asStaffDetail(issue, caller));
  }),

  http.put(`${API}/issues/:issueId`, async ({ request, params }) => {
    const path = new URL(request.url).pathname;
    const caller = resolveCaller(request);
    const denied = requireRole(caller, ['CITIZEN'], path);
    if (denied) {
      return denied;
    }
    const issueId = String(params['issueId']);
    const issue = state.issues.find((candidate) => candidate.id === issueId);
    // "Not the caller's report" is 404, not 403, and carries the contract's own
    // wording so a reader can see it is the enumeration rule doing the work.
    if (!issue || !isReporter(caller, issue)) {
      return notFound(path, 'Not found, not visible, or not the caller\'s report.');
    }

    // The editable window. Once a department has triaged it, the report is part of
    // an official record and is corrected through comments. 409, naming the two
    // editable statuses, so a UI can say what is wrong instead of just refusing.
    if (!['SUBMITTED', 'AI_ANALYZING'].includes(issue.status)) {
      return conflict(path, 'An issue can only be edited while SUBMITTED or AI_ANALYZING.');
    }

    const body = await readJson<IssueUpdateRequest>(request);
    if (!body) {
      return malformedBody(path);
    }
    const problems = updateProblems(body);
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
    if (typeof body.proposedCategoryText === 'string' || body.proposedCategoryText === null) {
      issue.proposedCategoryText = body.proposedCategoryText ?? null;
    }
    if (typeof body.categoryId === 'string' || body.categoryId === null) {
      const category = state.categories.find((candidate) => candidate.id === body.categoryId);
      issue.categoryId = category?.id ?? null;
      issue.categoryName = category?.name ?? null;
    }
    issue.updatedAt = issue.now;

    appendAudit({
      actorId: caller.userId,
      actorName: caller.displayName,
      action: 'ISSUE_EDITED',
      entityType: 'Issue',
      entityId: issue.id,
      oldValue: before,
      newValue: { title: issue.title },
      concealed: issue.disclosure === 'CONCEALED',
    });

    return HttpResponse.json(asTrackedDetail(issue));
  }),

  // --- comments ------------------------------------------------------------------------------------

  http.get(`${API}/issues/:issueId/comments`, ({ request, params }) => {
    const path = new URL(request.url).pathname;
    const caller = resolveCaller(request);
    const denied = requireRole(caller, ['CITIZEN', 'FIELD_OFFICER', 'DEPARTMENT_MANAGER', 'ADMIN'], path);
    if (denied) {
      return denied;
    }
    const issue = visibleIssue(caller, String(params['issueId']), path);
    if (issue instanceof Response) {
      return issue;
    }
    // A citizen's read is filtered to PUBLIC. The single most damaging bug this
    // endpoint could have is an internal note reaching a reporter, and a mock
    // returning every row would make it invisible until production.
    return HttpResponse.json(visibleComments(commentsForIssue(issue.id), caller));
  }),

  http.post(`${API}/issues/:issueId/comments`, async ({ request, params }) => {
    const path = new URL(request.url).pathname;
    const caller = resolveCaller(request);
    const denied = requireRole(caller, ['CITIZEN', 'FIELD_OFFICER', 'DEPARTMENT_MANAGER', 'ADMIN'], path);
    if (denied) {
      return denied;
    }
    const issue = visibleIssue(caller, String(params['issueId']), path);
    if (issue instanceof Response) {
      return issue;
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
    // Visibility is decided from the role and is never read from the request: a
    // client-settable visibility would let a citizen publish an internal note. A
    // body carrying one is *refused* rather than ignored, because silently
    // dropping it would let the client believe it worked.
    if (body.visibility !== undefined) {
      return validationError(path, 'Comment visibility is decided by the server.', [
        { field: 'visibility', issue: 'Not accepted from a client.' },
      ]);
    }

    // A citizen's comment is always PUBLIC and a staff comment is INTERNAL - the
    // contrast SPEC describes. There is no per-call choice, so a staff member
    // cannot leave a public note on a citizen's report without the server
    // deciding to.
    const isStaff = caller.role !== null && caller.role !== 'CITIZEN';
    const comment: StoredComment = {
      id: nextCommentId(),
      body: body.body,
      visibility: isStaff ? 'INTERNAL' : 'PUBLIC',
      authorId: caller.userId,
      authorName: caller.displayName,
      authorRole: caller.role!,
      concealedAuthor: false,
      createdAt: issue.now,
      editedAt: null,
      revisionCount: 0,
      editWindowEndsAt: null,
      deletedAt: null,
      concealedByToken: null,
      revisions: [],
      issueId: issue.id,
    };
    comment.editWindowEndsAt = editWindowEndsAt(comment, issue.now, true);
    state.comments.push(comment);

    appendAudit({
      actorId: caller.userId,
      actorName: caller.displayName,
      action: 'COMMENT_ADDED',
      entityType: 'Issue',
      entityId: issue.id,
      newValue: { commentId: comment.id, visibility: comment.visibility },
      concealed: issue.disclosure === 'CONCEALED',
    });

    return HttpResponse.json(asComment(comment, caller), { status: 201 });
  }),

  http.put(`${API}/issues/:issueId/comments/:commentId`, async ({ request, params }) => {
    const path = new URL(request.url).pathname;
    const caller = resolveCaller(request);
    const denied = requireRole(caller, ['CITIZEN', 'FIELD_OFFICER', 'DEPARTMENT_MANAGER', 'ADMIN'], path);
    if (denied) {
      return denied;
    }
    const issue = visibleIssue(caller, String(params['issueId']), path);
    if (issue instanceof Response) {
      return issue;
    }
    const comment = commentsForIssue(issue.id).find((candidate) => candidate.id === String(params['commentId']));
    if (!comment) {
      return notFound(path);
    }
    const expired = editWindowResponse(comment, issue.now, caller, path);
    if (expired) {
      return expired;
    }

    const body = await readJson<{ body?: string }>(request);
    if (!body) {
      return malformedBody(path);
    }
    if (!body.body || body.body.length < 1 || body.body.length > 5000) {
      return validationError(path, 'A comment body is required.', [
        { field: 'body', issue: 'Must be between 1 and 5000 characters.' },
      ]);
    }

    // Append a revision, never overwrite. SPEC 14: "Corrections are additive,
    // never destructive." The superseded text goes to `comment_revisions`, so a
    // thread can never appear to have been tampered with.
    comment.revisions = [
      ...comment.revisions,
      {
        id: nextRevisionId(),
        commentId: comment.id,
        body: comment.body,
        editedById: caller.userId,
        createdAt: issue.now,
      },
    ];
    comment.body = body.body;
    comment.revisionCount += 1;
    comment.editedAt = issue.now;
    comment.editWindowEndsAt = editWindowEndsAt(comment, issue.now, true);

    // Editing a PUBLIC comment invalidates a cached AI summary: it was written from
    // text that is no longer the text. Flagged rather than silently dropped, so a
    // UI can say the summary is stale instead of quoting a superseded version.
    const summaryStale = Boolean(comment.visibility === 'PUBLIC' && issue.resolutionReport?.aiSummary);

    appendAudit({
      actorId: caller.userId,
      actorName: caller.displayName,
      action: 'COMMENT_EDITED',
      entityType: 'Issue',
      entityId: issue.id,
      newValue: { commentId: comment.id, revisionCount: comment.revisionCount, aiSummaryStale: summaryStale },
      concealed: issue.disclosure === 'CONCEALED',
    });

    return HttpResponse.json(asComment(comment, caller));
  }),

  http.delete(`${API}/issues/:issueId/comments/:commentId`, ({ request, params }) => {
    const path = new URL(request.url).pathname;
    const caller = resolveCaller(request);
    const denied = requireRole(caller, ['CITIZEN', 'FIELD_OFFICER', 'DEPARTMENT_MANAGER', 'ADMIN'], path);
    if (denied) {
      return denied;
    }
    const issue = visibleIssue(caller, String(params['issueId']), path);
    if (issue instanceof Response) {
      return issue;
    }
    const comment = commentsForIssue(issue.id).find((candidate) => candidate.id === String(params['commentId']));
    if (!comment) {
      return notFound(path);
    }

    // Two paths, deliberately distinct. The author inside the window, or an ADMIN
    // moderating anyone's. Admin moderation is not a windowed edit - it is
    // moderation, and SPEC requires it be audited as such with a reason.
    const isAdminModeration = caller.role === 'ADMIN' && comment.authorId !== caller.userId;
    if (comment.authorId !== caller.userId && !isAdminModeration) {
      return HttpResponse.json(
        envelope(422, 'COMMENT_EDIT_WINDOW_EXPIRED', 'Only the author may delete this comment.', path),
        { status: 422 },
      );
    }
    if (!isAdminModeration) {
      const expired = editWindowResponse(comment, issue.now, caller, path);
      if (expired) {
        return expired;
      }
    }

    // Soft delete: the row survives with `deletedAt` set, the text is retained for
    // the audit trail and the retention job, and the client renders a tombstone -
    // so a thread never appears to have been tampered with.
    comment.deletedAt = issue.now;
    comment.editWindowEndsAt = null;

    appendAudit({
      actorId: caller.userId,
      actorName: caller.displayName,
      action: isAdminModeration ? 'COMMENT_MODERATED' : 'COMMENT_DELETED',
      entityType: 'Issue',
      entityId: issue.id,
      newValue: { commentId: comment.id },
      concealed: issue.disclosure === 'CONCEALED',
    });

    return new HttpResponse(null, { status: 204 });
  }),

  http.get(`${API}/issues/:issueId/comments/:commentId/revisions`, ({ request, params }) => {
    const path = new URL(request.url).pathname;
    const caller = resolveCaller(request);
    const denied = requireRole(caller, ['CITIZEN', 'FIELD_OFFICER', 'DEPARTMENT_MANAGER', 'ADMIN'], path);
    if (denied) {
      return denied;
    }
    const issue = visibleIssue(caller, String(params['issueId']), path);
    if (issue instanceof Response) {
      return issue;
    }
    const comment = commentsForIssue(issue.id).find((candidate) => candidate.id === String(params['commentId']));
    // Visibility follows the comment, so a citizen can only ever read the revision
    // history of a PUBLIC comment they can already see.
    if (!comment || !canSeeComment(comment, caller)) {
      return notFound(path);
    }
    return HttpResponse.json(comment.revisions);
  }),

  // --- lifecycle -----------------------------------------------------------------------------------

  http.post(`${API}/issues/:issueId/assign`, async ({ request, params }) => {
    const path = new URL(request.url).pathname;
    const caller = resolveCaller(request);
    const issue = staffIssue(caller, String(params['issueId']), path, ['DEPARTMENT_MANAGER', 'ADMIN']);
    if (issue instanceof Response) {
      return issue;
    }

    const body = await readJson<{ officerId?: string; note?: string }>(request);
    if (!body) {
      return malformedBody(path);
    }
    if (!body.officerId) {
      return validationError(path, 'An officer is required.', [{ field: 'officerId', issue: 'Required.' }]);
    }
    if (body.note !== undefined && body.note !== null && body.note.length > 1000) {
      return validationError(path, 'The note is too long.', [
        { field: 'note', issue: 'Must be at most 1000 characters.' },
      ]);
    }

    const officer = state.users.find((user) => user.id === body.officerId);
    if (!officer || officer.role !== 'FIELD_OFFICER') {
      return notFound(path, 'No such officer.');
    }

    // 422 for the officer being in the wrong department: the resource exists and
    // the operation is invalid for it, which is a different fact from the caller
    // being forbidden. SPEC makes the distinction explicitly.
    if (officer.departmentId !== issue.assignedDepartmentId) {
      return HttpResponse.json(
        envelope(422, 'OFFICER_NOT_IN_DEPARTMENT', 'That officer is not in this issue\'s department.', path),
        { status: 422 },
      );
    }
    if (officer.status === 'DISABLED') {
      return HttpResponse.json(
        envelope(422, 'OFFICER_NOT_IN_DEPARTMENT', 'That officer account is disabled.', path),
        { status: 422 },
      );
    }
    // A manager cannot reach across departments. 403, because this one *is* about
    // the caller's own scope rather than the target's.
    if (!isStaffInScope(caller, issue)) {
      return forbidden(path, 'Caller is not a manager of this issue\'s department.');
    }

    const verdict = evaluateTransition(issue.status, 'ASSIGNED', caller, { isReporter: false });
    if (!verdict.allowed) {
      return conflict(path, verdict.reason);
    }

    const previousOfficer = issue.assignedOfficerName;
    issue.assignedOfficerId = officer.id;
    issue.assignedOfficerName = officer.fullName;
    applyTransition(issue, 'ASSIGNED', caller, body.note ?? null);

    appendAudit({
      actorId: caller.userId,
      actorName: caller.displayName,
      action: previousOfficer ? 'ISSUE_REASSIGNED' : 'ISSUE_ASSIGNED',
      entityType: 'Issue',
      entityId: issue.id,
      oldValue: { assignedOfficerName: previousOfficer },
      newValue: { assignedOfficerId: officer.id },
      concealed: issue.disclosure === 'CONCEALED',
    });

    return HttpResponse.json(asStaffDetail(issue, caller));
  }),

  // `/status` and `/transition` are the same machine with the same authorization
  // and the same errors, so they share one implementation. `/transition` exists so
  // a queue view does not hand-roll transition logic - and it is deliberately NOT
  // a way to bypass `/resolve`, `/confirm` or `/reopen`. SPEC is explicit that it
  // is a thin alias, so making it a different implementation would create a second
  // set of answers to the same question.
  // The paths are written out in full rather than built from a suffix, so the coverage
  // gate in `check-generated-api.mjs` can resolve them textually; see the note at the
  // tail of this array.
  http.post(`${API}/issues/:issueId/status`, statusCommand()),
  http.post(`${API}/issues/:issueId/transition`, statusCommand()),

  http.post(`${API}/issues/:issueId/resolve`, async ({ request, params }) => {
    const path = new URL(request.url).pathname;
    const caller = resolveCaller(request);
    const issue = staffIssue(caller, String(params['issueId']), path, ['FIELD_OFFICER']);
    if (issue instanceof Response) {
      return issue;
    }

    // Multipart, like create: resolution evidence is a repeated file field.
    // Calling `request.json()` here would throw on every multipart body, so the
    // officer's resolve - the step that actually fixes a citizen's problem - would
    // be the one endpoint never exercised against the mock.
    const contentType = request.headers.get('Content-Type') ?? '';
    let notes: string | undefined;
    let evidenceCount = 0;
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      const raw = form.get('notes');
      notes = typeof raw === 'string' ? raw : undefined;
      evidenceCount = form.getAll('evidence').filter((entry) => entry instanceof File).length;
    } else {
      const body = await readJson<{ notes?: string; evidence?: string[] }>(request);
      notes = body?.notes;
      evidenceCount = body?.evidence?.length ?? 0;
    }

    if (!notes || notes.length < 10 || notes.length > 5000) {
      return validationError(path, 'Resolution notes are required.', [
        { field: 'notes', issue: 'Must be between 10 and 5000 characters.' },
      ]);
    }

    // Only the assignee may resolve. 403, not 404, because both the officer and
    // the issue exist and the contract says this case is a 403.
    if (issue.assignedOfficerId !== caller.userId) {
      return forbidden(path, 'Caller is not the assignee.');
    }

    const verdict = evaluateTransition(issue.status, 'RESOLVED', caller, {
      assigneeId: issue.assignedOfficerId,
    });
    if (!verdict.allowed) {
      return conflict(path, verdict.reason);
    }

    applyTransition(issue, 'RESOLVED', caller, 'Resolution proposed.');

    // A `ResolutionReport`, not a comment: SPEC creates it here because it is what
    // the AI summary is written against. Evidence is recommended but not
    // mandatory - an officer fixing a buried water main has nothing to photograph -
    // so the count is recorded and never required.
    issue.resolutionReport = {
      id: `res-${issue.id}`,
      notes,
      aiSummary: null,
      officerId: caller.userId!,
      officerName: caller.displayName,
      submittedAt: issue.now,
    };
    issue.photoCount += evidenceCount;

    appendAudit({
      actorId: caller.userId,
      actorName: caller.displayName,
      action: 'ISSUE_RESOLVED',
      entityType: 'Issue',
      entityId: issue.id,
      newValue: { evidenceCount },
      concealed: issue.disclosure === 'CONCEALED',
    });

    // Resolving *proposes*. The approval deadline is set by `applyTransition`, and
    // nothing here closes the report - that is the reporter's call, and it is the
    // gate that makes "resolving proposes, the reporter disposes" real rather than
    // decorative.
    return HttpResponse.json(asStaffDetail(issue, caller));
  }),

  // --- the reporter's own dispositions ---------------------------------------------------------------

  http.post(`${API}/issues/:issueId/confirm`, ({ request, params }) => {
    const path = new URL(request.url).pathname;
    const caller = resolveCaller(request);
    const denied = requireRole(caller, ['CITIZEN'], path);
    if (denied) {
      return denied;
    }
    const issue = state.issues.find((candidate) => candidate.id === String(params['issueId']));
    if (!issue || !isReporter(caller, issue)) {
      return notFound(path);
    }

    // Only the reporter may close, and only from RESOLVED. The state machine holds
    // both: the CLOSED edge is CITIZEN-only and gated on `isReporter`, so nobody
    // closes a citizen's report for them - including staff, including an admin.
    const verdict = evaluateTransition(issue.status, 'CLOSED', caller, { isReporter: true });
    if (!verdict.allowed) {
      return conflict(path, verdict.reason);
    }

    issue.confirmationCount += 1;
    applyTransition(issue, 'CLOSED', caller, 'Reporter confirmed the fix.');
    appendAudit({
      actorId: caller.userId,
      actorName: caller.displayName,
      action: 'ISSUE_CLOSED',
      entityType: 'Issue',
      entityId: issue.id,
      concealed: issue.disclosure === 'CONCEALED',
    });

    return HttpResponse.json(asTrackedDetail(issue));
  }),

  http.post(`${API}/issues/:issueId/reopen`, async ({ request, params }) => {
    const path = new URL(request.url).pathname;
    const caller = resolveCaller(request);
    const denied = requireRole(caller, ['CITIZEN'], path);
    if (denied) {
      return denied;
    }
    const issue = state.issues.find((candidate) => candidate.id === String(params['issueId']));
    if (!issue || !isReporter(caller, issue)) {
      return notFound(path);
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

    // The window, checked before the transition. Reachable from CLOSED as well as
    // RESOLVED, and with auto-close gone this is the only thing protecting a
    // disputed fix - so an expired window is a 422 with its own code, not a 409.
    if (issue.reopenWindowEndsAt && Date.parse(issue.now) > Date.parse(issue.reopenWindowEndsAt)) {
      return HttpResponse.json(
        envelope(422, 'REOPEN_WINDOW_EXPIRED', 'The reopen window for this fix has closed.', path),
        { status: 422 },
      );
    }

    const verdict = evaluateTransition(issue.status, 'REOPENED', caller, { isReporter: true });
    if (!verdict.allowed) {
      return conflict(path, verdict.reason);
    }

    applyTransition(issue, 'REOPENED', caller, body.reason);
    appendAudit({
      actorId: caller.userId,
      actorName: caller.displayName,
      action: 'ISSUE_REOPENED',
      entityType: 'Issue',
      entityId: issue.id,
      newValue: { reason: body.reason },
      concealed: issue.disclosure === 'CONCEALED',
    });

    return HttpResponse.json(asTrackedDetail(issue));
  }),

  http.get(`${API}/issues/:issueId/duplicates`, ({ request, params }) => {
    const path = new URL(request.url).pathname;
    const caller = resolveCaller(request);
    const issue = staffIssue(caller, String(params['issueId']), path, ['DEPARTMENT_MANAGER', 'ADMIN']);
    if (issue instanceof Response) {
      return issue;
    }
    // Candidates only ever arrive as SUGGESTED and nothing is auto-merged. Reviewed
    // rows stay visible: a manager needs to see what was rejected as much as what
    // is pending.
    return HttpResponse.json(state.duplicates.filter((match) => match.issueId === issue.id));
  }),

  http.post(`${API}/duplicates/:matchId/confirm`, duplicateCommand()),
  http.post(`${API}/duplicates/:matchId/reject`, duplicateCommand()),
];

/**
 * `/duplicates/{matchId}/confirm` and `.../reject`, from one implementation.
 *
 * A duplicate is never merged by the system. Confirming a match only records that
 * a manager *agreed* the two reports are the same problem, and the issue still has
 * to be moved to DUPLICATE through the state machine like any other transition -
 * which is the point SPEC makes when it says a confirm "allows" a manager to do
 * that. Modelling the confirm as a merge would let a report disappear on a
 * suggestion that a human has not read.
 *
 * Both write the reviewer's identity and the decision into the row, and neither is
 * reversible: a manager who confirmed the wrong candidate opens a fresh match rather
 * than editing this one, so the review history stays honest.
 */
function duplicateCommand(): HttpResponseResolver<PathParams> {
  return ({ request, params }) => {
    const path = new URL(request.url).pathname;
    const action = path.endsWith('/confirm') ? 'confirm' : 'reject';
    const caller = resolveCaller(request);
    const denied = requireRole(caller, ['DEPARTMENT_MANAGER', 'ADMIN'], path);
    if (denied) {
      return denied;
    }

    const match = state.duplicates.find((candidate) => candidate.id === String(params['matchId']));
    // The match must exist *and* name an issue this caller may see. 404 for every
    // failure, matching the endpoint's single documented error, so a caller cannot
    // distinguish "no such match" from "not yours" by status code.
    const issue = match ? state.issues.find((candidate) => candidate.id === match.issueId) : undefined;
    if (!match || !issue || !canSeeIssue(caller, issue)) {
      return notFound(path);
    }

    // Already decided. 409 rather than a silent success, because a double-click on
    // a confirm button is a client bug and the second one changed nothing.
    if (match.status !== 'SUGGESTED') {
      return conflict(path, `This duplicate match has already been ${match.status?.toLowerCase()}.`);
    }

    match.status = action === 'confirm' ? 'CONFIRMED' : 'REJECTED';
    match.reviewedById = caller.userId;
    match.reviewedAt = NOW;

    appendAudit({
      actorId: caller.userId,
      actorName: caller.displayName,
      action: action === 'confirm' ? 'DUPLICATE_CONFIRMED' : 'DUPLICATE_REJECTED',
      entityType: 'Issue',
      entityId: issue.id,
      oldValue: { duplicateStatus: 'SUGGESTED' },
      newValue: { duplicateStatus: match.status, candidatePublicCode: match.candidatePublicCode },
      concealed: issue.disclosure === 'CONCEALED',
    });

    return HttpResponse.json(match);
  };
}

/**
 * `/status` and `/transition` from one implementation.
 *
 * Built as a factory so the two handlers are provably the same code rather than
 * two functions that were copied and have since drifted. `/status` additionally
 * reports an impermissible transition as 403 when the *role* could never make it,
 * because its contract declares that case explicitly; `/transition` does not, and
 * that asymmetry is a property of the contract rather than an inconsistency here.
 */
function statusCommand(): HttpResponseResolver<PathParams> {
  return async ({ request, params }) => {
    const path = new URL(request.url).pathname;
    // Derived from the request rather than passed in, so both routes provably run
    // the same code and neither registration can quietly diverge.
    const suffix = path.endsWith('/status') ? '/status' : '/transition';
    const caller = resolveCaller(request);
    const issue = staffIssue(caller, String(params['issueId']), path, ['DEPARTMENT_MANAGER', 'ADMIN']);
    if (issue instanceof Response) {
      return issue;
    }
    const body = await readJson<{ targetStatus?: string; reason?: string }>(request);
    if (!body) {
      return malformedBody(path);
    }
    if (!body.targetStatus) {
      return validationError(path, 'A target status is required.', [
        { field: 'targetStatus', issue: 'Required.' },
      ]);
    }
    if (body.reason !== undefined && body.reason !== null && body.reason.length > 1000) {
      return validationError(path, 'The reason is too long.', [
        { field: 'reason', issue: 'Must be at most 1000 characters.' },
      ]);
    }

    const verdict = evaluateTransition(issue.status, body.targetStatus as never, caller, {
      assigneeId: issue.assignedOfficerId,
      isReporter: isReporter(caller, issue),
    });
    if (!verdict.allowed) {
      // A role that could never make this transition is 403 - "the endpoint's
      // vocabulary" - while a role that could, but the edge is not permitted from
      // this status, is 409. The contract's 403 description for `/status` is
      // literally "role is never allowed to make this transition", which is the
      // second case in this machine's terms.
      const roleIsTheProblem =
        verdict.reason === 'Role is never allowed to make this transition.' && suffix === '/status';
      if (roleIsTheProblem) {
        return forbidden(path, 'Role is never allowed to make this transition.');
      }
      return conflict(path, verdict.reason);
    }
    if (verdict.edge.reasonRequired && !body.reason) {
      return validationError(path, 'A reason is required for this transition.', [
        { field: 'reason', issue: 'Required for REJECTED, REOPENED and CANCELLED.' },
      ]);
    }

    const from = issue.status;
    applyTransition(issue, body.targetStatus as never, caller, body.reason ?? null);
    appendAudit({
      actorId: caller.userId,
      actorName: caller.displayName,
      action: 'ISSUE_STATUS_CHANGED',
      entityType: 'Issue',
      entityId: issue.id,
      oldValue: { status: from },
      newValue: { status: body.targetStatus },
      concealed: issue.disclosure === 'CONCEALED',
    });

    return HttpResponse.json(asStaffDetail(issue, caller));
  };
}

/** The length bounds `IssueUpdateRequest` declares. */
function updateProblems(body: IssueUpdateRequest): { field: string; issue: string }[] {
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
  return problems;
}


