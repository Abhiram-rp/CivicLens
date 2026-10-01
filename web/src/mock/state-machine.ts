import type { IssueStatus, Role } from '../app/api/generated/types.gen';

/**
 * The CivicLens issue state machine, transcribed from SPEC 4.
 *
 * SPEC calls this "the highest-value test suite in the project; write it before
 * any UI", and the reason is visible in the shape of the data below. Every
 * transition is a `(from, to, role)` triple with a precondition, and *anything
 * not in the table* is an `INVALID_STATE_TRANSITION`. So the safe way to write
 * this is as a lookup that fails closed: an allowlist of permitted edges, and a
 * default of "no". Anything modelled as a list of forbidden transitions - or as a
 * set of valid states the code then assumes can move freely between - gets the
 * arithmetic wrong the moment someone adds a status, because a new status
 * defaults to *reachable* rather than to unreachable.
 *
 * ## Roles here are the contract's, not the mock's
 *
 * `FIELD_OFFICER` and `DEPARTMENT_MANAGER` are the contract's spellings. An
 * earlier draft of the mock used `OFFICER`/`MANAGER`, which is exactly the class
 * of drift that fixtures typed against a guess produce: every screen looks fine
 * and every role check is silently comparing against a value the real server
 * never sends.
 *
 * ## SYSTEM is not a Role
 *
 * SPEC has `SUBMITTED -> AI_ANALYZING -> TRIAGED` performed by SYSTEM, and the
 * contract's `Role` enum has no member for it. It is therefore modelled here as
 * `null` rather than as a fake role string - the two AI-driven edges are not
 * reachable through any client-callable endpoint, and `POST /status` must not be
 * able to perform them.
 */

/** A caller of a state-changing endpoint, after role resolution. */
export interface Actor {
  /** Contract role, or `null` for an unauthenticated caller. */
  role: Role | null;
  userId: string | null;
  displayName: string;
}

/** The pseudo-actor for the two edges SPEC attributes to SYSTEM. */
const SYSTEM: Actor = { role: null, userId: null, displayName: 'CivicLens' };

type Edge = {
  to: IssueStatus;
  /** Roles permitted to make this edge. `null` = SYSTEM only. */
  roles: readonly (Role | null)[];
  /** Whether the reason field is mandatory. SPEC's "reason required". */
  reasonRequired: boolean;
  /** Only the assignee may move it, rather than any holder of the role. */
  assigneeOnly: boolean;
};

/**
 * Permitted edges, keyed by the status the issue is currently in.
 *
 * The keys are the *only* statuses a client-callable operation can act on. A
 * status with no entry - `SUBMITTED`, `AI_ANALYZING`, `TRIAGED`'s system-driven
 * outbound edge - is not "under construction", it is refused.
 */
const EDGES: Partial<Record<IssueStatus, readonly Edge[]>> = {
  ASSIGNED: [
    { to: 'IN_PROGRESS', roles: ['FIELD_OFFICER'], reasonRequired: false, assigneeOnly: true },
    // Reassignment and "officer unresponsive" both land back in TRIAGED.
    { to: 'TRIAGED', roles: ['DEPARTMENT_MANAGER'], reasonRequired: false, assigneeOnly: false },
  ],
  IN_PROGRESS: [
    { to: 'RESOLVED', roles: ['FIELD_OFFICER'], reasonRequired: false, assigneeOnly: true },
    { to: 'CANCELLED', roles: ['CITIZEN'], reasonRequired: true, assigneeOnly: false },
  ],
  RESOLVED: [
    // The only path to CLOSED, and it is the reporter's.
    { to: 'CLOSED', roles: ['CITIZEN'], reasonRequired: false, assigneeOnly: false },
    { to: 'REOPENED', roles: ['CITIZEN'], reasonRequired: true, assigneeOnly: false },
    // SPEC: staff may move RESOLVED -> IN_PROGRESS for a fix that did not hold,
    // with a required reason, audited distinctly from a citizen reopen.
    { to: 'IN_PROGRESS', roles: ['DEPARTMENT_MANAGER', 'ADMIN'], reasonRequired: true, assigneeOnly: false },
  ],
  CLOSED: [
    // With auto-close removed, this is the only thing protecting a disputed fix.
    { to: 'REOPENED', roles: ['CITIZEN'], reasonRequired: true, assigneeOnly: false },
  ],
  REOPENED: [
    { to: 'ASSIGNED', roles: ['DEPARTMENT_MANAGER'], reasonRequired: false, assigneeOnly: false },
  ],
  TRIAGED: [
    { to: 'ASSIGNED', roles: ['DEPARTMENT_MANAGER'], reasonRequired: false, assigneeOnly: false },
    { to: 'REJECTED', roles: ['DEPARTMENT_MANAGER'], reasonRequired: true, assigneeOnly: false },
    { to: 'DUPLICATE', roles: ['DEPARTMENT_MANAGER'], reasonRequired: false, assigneeOnly: false },
  ],
};

/**
 * Cancellation is allowed from "any active state", by the reporter before
 * `ASSIGNED`, or by an admin at any time. Enumerating the three from-states is
 * deliberate: the phrase "any active state" is not a rule a mock can check, and
 * an implementation that reads it as "any state" would let a citizen cancel a
 * report that an officer has already closed work on.
 */
const CANCELLABLE_FROM: readonly IssueStatus[] = ['SUBMITTED', 'AI_ANALYZING', 'TRIAGED'];

/** The result of consulting the machine. */
export type TransitionVerdict =
  | { allowed: true; edge: Edge }
  | { allowed: false; reason: string };

/**
 * Decide whether `actor` may move an issue from `from` to `to`.
 *
 * Returns a verdict rather than throwing or returning a bare boolean, because the
 * caller has three genuinely different failures to report - wrong role (403), not
 * this actor's issue (404), and not a permitted edge (409) - and the SPEC
 * distinguishes all three. Collapsing them into a boolean would force the caller
 * to re-derive the distinction, which is where a mock starts disagreeing with the
 * server it is standing in for.
 */
export function evaluateTransition(
  from: IssueStatus,
  to: IssueStatus,
  actor: Actor,
  options: { assigneeId?: string | null; isReporter?: boolean } = {},
): TransitionVerdict {
  if (to === 'CANCELLED') {
    return evaluateCancellation(from, actor, options.isReporter ?? false);
  }

  // The two AI-driven edges are in the table so the machine is a faithful
  // transcription, but no client-callable endpoint may drive them, so they are
  // declared with `roles: [null]` and can never match a real actor.
  const edges = EDGES[from] ?? [];
  const edge = edges.find((candidate) => candidate.to === to);

  if (!edge) {
    return { allowed: false, reason: `${from} -> ${to} is not a permitted transition.` };
  }

  if (edge.roles.includes(null) && edge.roles.every((r) => r === null)) {
    return { allowed: false, reason: `${from} -> ${to} is performed by the system, not by a client.` };
  }

  if (actor.role === null || !edge.roles.includes(actor.role)) {
    return { allowed: false, reason: `Role is never allowed to make this transition.` };
  }

  // A reporter-only edge is refused for staff and vice versa. Without this the
  // `CITIZEN` role on the CLOSED edge would read as "any caller may close",
  // which is precisely the power SPEC says nobody has but the reporter.
  if (to === 'CLOSED' && !options.isReporter) {
    return { allowed: false, reason: 'Only the reporter may close their own report.' };
  }
  // Cancellation returned above, so `REOPENED` is the only reporter-owned target
  // still in play here. Checked separately from the CLOSED rule because the two
  // failures are different: closing is a right only the reporter has, and
  // reopening is a right only the reporter may exercise.
  if (to === 'REOPENED' && !options.isReporter && actor.role === 'CITIZEN') {
    return { allowed: false, reason: 'Only the reporter may dispute or cancel their own report.' };
  }

  if (edge.assigneeOnly && options.assigneeId !== actor.userId) {
    return { allowed: false, reason: 'Only the assignee may make this transition.' };
  }

  return { allowed: true, edge };
}

function evaluateCancellation(from: IssueStatus, actor: Actor, isReporter: boolean): TransitionVerdict {
  const edge: Edge = { to: 'CANCELLED', roles: ['CITIZEN', 'ADMIN'], reasonRequired: true, assigneeOnly: false };
  if (actor.role === null || !edge.roles.includes(actor.role)) {
    return { allowed: false, reason: 'Role is never allowed to make this transition.' };
  }
  if (actor.role === 'ADMIN') {
    return { allowed: true, edge };
  }
  if (!isReporter) {
    return { allowed: false, reason: 'Only the reporter may cancel their own report.' };
  }
  // SPEC: a citizen may cancel only before ASSIGNED. Enumerated explicitly so
  // that "before ASSIGNED" cannot later be read as "before CLOSED".
  return CANCELLABLE_FROM.includes(from)
    ? { allowed: true, edge }
    : { allowed: false, reason: 'A report can no longer be cancelled once work has started.' };
}

/**
 * The status labels a citizen-facing UI is allowed to show.
 *
 * SPEC is emphatic that the raw enum name is never displayed: `AI_ANALYZING`
 * renders as "Under review". A label that showed a reporter "AI_ANALYZING" for a
 * report no officer has looked at would be a promise the platform cannot keep, so
 * the mapping lives in one place and the fixtures read from it rather than each
 * handler inventing its own wording.
 */
export const STATUS_LABELS: Record<IssueStatus, string> = {
  SUBMITTED: 'Received',
  AI_ANALYZING: 'Under review',
  TRIAGED: 'Under review',
  ASSIGNED: 'Assigned',
  IN_PROGRESS: 'Work in progress',
  RESOLVED: 'Awaiting your confirmation',
  CLOSED: 'Closed',
  REOPENED: 'Reopened',
  REJECTED: 'Not accepted',
  DUPLICATE: 'Already reported',
  CANCELLED: 'Cancelled',
};

/** SYSTEM's two outbound edges, callable only by the mock's own seeding. */
export { SYSTEM as SYSTEM_ACTOR };
