import type {
  Comment,
  IssueDetail,
  IssueSummary,
  PublicIssue,
  TrackedIssueDetail,
} from '../app/api/generated/types.gen';
import { STATUS_LABELS } from './state-machine';
import { editWindowEndsAt, state, userById, type StoredComment, type StoredIssue } from './store';
import type { Caller } from './http';

/**
 * Every projection from a stored row to a response shape.
 *
 * Collected in one file because the *difference between these projections* is
 * the security model. A concealed reporter's report, read as staff and read as
 * the reporter, produce two different documents from one row - and the fields
 * that differ are exactly the ones that matter:
 *
 * | field | staff | reporter (tracked) | public |
 * |---|---|---|---|
 * | `reporterDisplayName` | only for a SHARED report | never | never |
 * | `latitude`/`longitude` | yes | no | no |
 * | `address` | yes | no | no |
 * | `assignedOfficerName` | yes | yes | no |
 *
 * Keeping these as separate functions rather than one with a `forStaff` flag is
 * the point. A flag would be a place where one careless call site leaks every
 * field to every caller, and the leak would be invisible in review because the
 * function signature would look the same.
 */

/** The issue's own record, with no identity resolution and no redaction. */
function baseDetail(issue: StoredIssue): IssueDetail {
  const {
    reporterId: _reporterId,
    contactEmail: _contactEmail,
    revealRequested: _revealRequested,
    createKey: _createKey,
    now: _now,
    assignedOfficerId: _assignedOfficerId,
    ...detail
  } = issue;
  return detail;
}

/**
 * The staff projection of an issue.
 *
 * Two rules do the work here.
 *
 * **A concealed report never gets a reporter name.** Not for a manager, not for
 * an admin. SPEC 7.1: "the reporter asked not to be identified, and no internal
 * role is a reason to override that." So the name is resolved from `reporterId`,
 * which is `null` for concealed - meaning the rule holds structurally rather than
 * because this function remembers to check `disclosure`.
 *
 * **The officer's name is visible to the reporter, including concealed.** That is
 * the opposite decision and it is deliberate: SPEC calls it "the single most
 * trust-building field on the screen", and "a name is not a note". So concealing
 * identity must not extend to concealing who is working on the problem.
 */
export function asStaffDetail(issue: StoredIssue, caller: Caller): IssueDetail {
  const detail = baseDetail(issue);
  const reporter = issue.reporterId ? userById(issue.reporterId) : undefined;
  return {
    ...detail,
    // A null reporter for a concealed report, by construction: `reporterId` is
    // null so there is nothing to resolve.
    reporterDisplayName: issue.disclosure === 'CONCEALED' ? null : (reporter?.fullName ?? null),
    // The email is never echoed to anyone - SPEC 7.1, "not even to the reporter
    // who supplied it", because a response that returns it ends up in a log.
    contactState: issue.disclosure === 'CONCEALED' ? issue.contactState : undefined,
    assignedOfficerName: issue.assignedOfficerName,
    statusLabel: issue.statusLabel || STATUS_LABELS[issue.status],
  };
}

/**
 * The reporter's own projection, for both the tracked tree and a citizen reading
 * their report through their session.
 *
 * No coordinates, no address, no reporter block, no officer id. A concealed
 * reporter reaches this from any device holding only a token, so this is the
 * response where a leak would be most damaging and least likely to be caught by
 * hand - which is why `latitude` and `longitude` are simply not here rather than
 * being conditionally omitted.
 */
export function asTrackedDetail(issue: StoredIssue): TrackedIssueDetail {
  return {
    id: issue.id,
    publicCode: issue.publicCode,
    title: issue.title,
    description: issue.description,
    status: issue.status,
    statusLabel: issue.statusLabel || STATUS_LABELS[issue.status],
    disclosure: issue.disclosure,
    priority: issue.priority,
    categoryName: issue.categoryName,
    areaLabel: issue.areaLabel,
    assignedDepartmentName: issue.assignedDepartmentName,
    contactState: issue.disclosure === 'CONCEALED' ? issue.contactState : undefined,
    approvalDeadline: issue.approvalDeadline,
    confirmationCount: issue.confirmationCount,
    photoCount: issue.photoCount,
    statusHistory: issue.statusHistory,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

/**
 * The `PublicIssue` projection.
 *
 * `PublicIssue` has no reporter field at all - the contract enforces concealment
 * structurally here rather than by asking the server to omit one. So there is
 * nothing to redact and nothing a caller could get wrong.
 */
export function asPublicIssue(issue: StoredIssue): PublicIssue {
  return {
    publicCode: issue.publicCode,
    title: issue.title,
    // Never redacted in the mock. `titleRedacted` exists for a report whose *title*
    // carries identifying detail; that would be a per-issue decision made at
    // submission, and inventing one would make the flag look exercised when it
    // is not.
    titleRedacted: false,
    categoryName: issue.categoryName,
    status: issue.status,
    statusLabel: issue.statusLabel || STATUS_LABELS[issue.status],
    priority: issue.priority,
    confirmationCount: issue.confirmationCount,
    photoCount: issue.photoCount,
    areaLabel: issue.areaLabel,
    submittedAt: issue.createdAt,
    resolvedAt: issue.resolvedAt,
    closedAt: issue.closedAt,
  };
}

/**
 * The list projection.
 *
 * Deliberately lean: no description body, no comments, no coordinates. The
 * contract's reason is "list payloads are what a citizen on a weak connection pays
 * for", and the way to honour that is to build the object field by field. Spreading
 * the detail and deleting a few keys would leak the body text into every list
 * request the first time someone added a field.
 */
export function asSummary(issue: StoredIssue): IssueSummary {
  return {
    id: issue.id,
    publicCode: issue.publicCode,
    title: issue.title,
    status: issue.status,
    statusLabel: issue.statusLabel || STATUS_LABELS[issue.status],
    priority: issue.priority,
    categoryName: issue.categoryName,
    areaLabel: issue.areaLabel,
    confirmationCount: issue.confirmationCount,
    photoCount: issue.photoCount,
    assignedDepartmentName: issue.assignedDepartmentName,
    disclosure: issue.disclosure,
    // Undefined rather than null for a shared report: the contract distinguishes
    // "not applicable" from "unknown", and a shared report has no channel to be
    // in a state.
    contactState: issue.disclosure === 'CONCEALED' ? issue.contactState : undefined,
    approvalDeadline: issue.approvalDeadline,
    proposedCategoryText: issue.proposedCategoryText,
    // SPEC: RESOLVED with no confirmation. Stale-resolution queue input, never an
    // automatic close.
    awaitingConfirmation: issue.status === 'RESOLVED' && issue.closedAt === null,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

/** The `Comment` projection, with the edit window resolved for this caller. */
export function asComment(comment: StoredComment, caller: Caller): Comment {
  const isAuthor = comment.authorId !== null && comment.authorId === caller.userId;
  return {
    id: comment.id,
    // Empty once tombstoned; the client renders the tombstone, not the text.
    body: comment.body,
    visibility: comment.visibility,
    // Null for a concealed reporter's comment - attributable to the token, which
    // is never exposed.
    authorId: comment.authorId,
    authorName: comment.authorName,
    authorRole: comment.authorRole,
    concealedAuthor: comment.concealedAuthor,
    createdAt: comment.createdAt,
    editedAt: comment.editedAt,
    revisionCount: comment.revisionCount,
    editWindowEndsAt: editWindowEndsAt(comment, comment.createdAt, isAuthor),
    deletedAt: comment.deletedAt,
  };
}

/**
 * A comment as seen from the tracked tree.
 *
 * The same shape, but `editWindowEndsAt` is always null: the caller is the token,
 * not a user, so there is no author to edit as and no button to offer. A mock
 * that computed the window against the token would either show an edit action that
 * always 422s or hide one a legitimate author could have used.
 */
export function asTrackedComment(comment: StoredComment): Comment {
  return {
    ...asComment(comment, { role: null, userId: null, displayName: 'concealed reporter', trackingToken: null, user: null }),
    editWindowEndsAt: null,
  };
}

/**
 * Comments on an issue, oldest first - the order a thread reads in.
 *
 * Reads the live array rather than a snapshot, so a comment posted and then
 * fetched in the same session appears without a reseed.
 */
export function commentsForIssue(issueId: string): StoredComment[] {
  return state.comments.filter((comment) => comment.issueId === issueId);
}

/**
 * Whether a caller may see a comment.
 *
 * Staff see everything; a citizen sees only PUBLIC. This is the filter SPEC calls
 * out as "the most damaging single bug this endpoint could have" - an internal
 * note leaking to a citizen - so it lives in one function used by the list, the
 * edit, the delete and the revisions endpoints. Four call sites that each checked
 * it correctly today would be four chances to get it wrong tomorrow.
 */
export function canSeeComment(comment: StoredComment, caller: Caller): boolean {
  if (caller.role !== null && caller.role !== 'CITIZEN') {
    return true;
  }
  return comment.visibility === 'PUBLIC';
}

/**
 * Comments a caller may see on an issue, already filtered.
 *
 * Filtered here rather than in each handler so that "a citizen's comment list
 * contains no INTERNAL row" is a property of one function, and a test can assert
 * it directly rather than asserting that four handlers each called the right
 * thing.
 */
export function visibleComments(
  comments: StoredComment[],
  caller: Caller,
  { asTracked = false }: { asTracked?: boolean } = {},
): Comment[] {
  return comments
    .filter((comment) => canSeeComment(comment, caller))
    .map((comment) => (asTracked ? asTrackedComment(comment) : asComment(comment, caller)));
}
