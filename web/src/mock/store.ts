import type {
  AuditLog,
  Category,
  Comment,
  CommentRevision,
  ContactState,
  CurrentUser,
  Department,
  DuplicateMatch,
  ErrorEnvelope,
  IssueDetail,
  IssueStatus,
  Notification,
  Role,
  SlaPolicy,
  User,
  UserStatus,
} from '../app/api/generated/types.gen';
import { STATUS_LABELS } from './state-machine';

/**
 * The mock server's mutable state, and the only module that writes to it.
 *
 * ## Why this exists
 *
 * The first version of this mock answered every request from a constant. That
 * works for the endpoints that only read, and quietly lies about the rest:
 * assign an issue and `GET /issues/{id}` returns the status the fixture was seeded
 * with. A triage screen built against that looks finished and is not - in
 * production the report is still `TRIAGED` after the manager assigned it, and the
 * officer's queue never shows it.
 *
 * So the store is mutable, and the rule behind every decision below is: **a mock
 * endpoint that does not change state is a mock endpoint nobody can develop
 * against.**
 *
 * ## What is deliberately *not* modelled
 *
 * - No persistence. A reload reseeds. A mock that wrote to disk would outlive the
 *   session and eventually be mistaken for a backend.
 * - No concurrency. Two overlapping writes interleave arbitrarily, which is right
 *   for a development mock and worth nothing as a model of a real server.
 * - No timers. Nothing advances on a clock; timestamps come from `at()`, so a
 *   screenshot taken today matches one taken next month.
 *
 * The one thing that *is* modelled, because getting it wrong is the bug this
 * exists to prevent, is **visibility**: a concealed report keeps
 * `reporterId: null` and no projection below can ever produce a name for it.
 */

/**
 * Every field of a generated type, made non-optional.
 *
 * The generator emits `photoCount?: number` because `photoCount` is not in the
 * schema's `required` list, and that is correct for the *wire*: a server may omit
 * it. It is wrong for a *row the mock itself created*, because the mock always
 * sets it, and inheriting the optionality means every handler reads
 * `issue.photoCount` as `number | undefined` and has to narrow or coerce it.
 * With twenty-odd optional fields that coercion ends up scattered across every
 * projection and handler, which is exactly the kind of noise where a `?? 0` gets
 * added somewhere it should not be and quietly turns a missing field into a zero.
 *
 * So the store types are `Required<>`. That is not a claim the *server* guarantees
 * these fields; it is a claim that the mock, having written the row, knows them.
 * `Required` also removes `undefined` from each property while keeping the `null`
 * the contract declares, so `reporterId` stays `string | null` rather than
 * becoming `string`.
 */
type Solid<T> = Required<T>;

/** A user, plus the password the mock accepts. Never leaves this module. */
export type StoredUser = Solid<User> & {
  /** Mock-only. The contract's `User` "never contains a password hash". */
  password: string;
  /** Set by `POST /auth/register`, to keep self-service distinct from admin creation. */
  selfRegistered: boolean;
};

/** A comment, plus the bookkeeping the edit window needs. */
export type StoredComment = Solid<Comment> & {
  /**
   * The comment's issue.
   *
   * Store-only, and absent from the contract's `Comment` type - every comment
   * endpoint is already scoped by a path parameter, so the response does not need
   * to repeat the parent. Keeping it as a field rather than threading it through
   * every lookup is what lets `listComments` be one filter instead of a query per
   * call.
   */
  issueId: string;
  /** Set for a concealed reporter's comment: the token, never a user id. */
  concealedByToken: string | null;
  revisions: Solid<CommentRevision>[];
};

/** An issue, plus what the state machine, audit trail and windows need. */
export type StoredIssue = Solid<Omit<IssueDetail, 'contactState'>> & {
  /**
   * `undefined` for a shared report rather than null, because the contract says
   * `contactState` is absent when there is no contact channel - "not applicable" is
   * not "unknown yet". The key stays required so every projection has to make that
   * decision explicitly instead of inheriting an absent field by accident.
   */
  contactState: ContactState | undefined;
  /**
   * The concealed reporter's address, kept only so `/contact/verify` can match a
   * token to the right channel.
   *
   * Nothing reads this to *render* anything, and `asIssueDetail`/`asTracked`/
   * `asPublic` all drop it. SPEC 7.1 says the address is never echoed to anyone,
   * not even the reporter who supplied it, because a response that returns it is
   * a response that ends up in a log.
   */
  contactEmail: string | null;
  /** True once a concealed reporter has asked to stop being concealed. */
  revealRequested: boolean;
  /** The `Idempotency-Key` of the create, so a replay is traceable. */
  createKey: string | null;
  /** ISO instant the fixture set treats as "now". */
  now: string;
}

/** The reference-data rows, solid for the same reason as the issue rows. */
export type StoredDepartment = Solid<Department>;
/** Recursive: the contract flattens subcategories into `Array<Category>`, and a
 *  store that kept them loose would make `category.subcategories[0].id` a
 *  `string | undefined` inside every handler that walks the taxonomy. */
export type StoredCategory = Solid<Omit<Category, 'subcategories'>> & {
  subcategories: StoredCategory[];
};
export type StoredSlaPolicy = Solid<SlaPolicy>;
export type StoredAuditLog = Solid<AuditLog>;
export type StoredNotification = Solid<Notification>;
export type StoredDuplicate = Solid<DuplicateMatch>;

/** One mutable world. Seeded at import, reset by `resetMockState()`. */
export interface MockState {
  users: StoredUser[];
  departments: StoredDepartment[];
  categories: StoredCategory[];
  issues: StoredIssue[];
  comments: StoredComment[];
  duplicates: StoredDuplicate[];
  slaPolicies: StoredSlaPolicy[];
  auditLogs: StoredAuditLog[];
  notifications: StoredNotification[];
  /**
   * Registered push tokens. Nothing is dispatched - SPEC says the row is stored
   * and "nothing is dispatched yet" - so a registration that produced no delivery
   * is faithful rather than incomplete.
   */
  deviceTokens: { token: string; platform: 'ANDROID' | 'IOS' | 'WEB'; userId: string }[];
  /**
   * Single-use tokens for `/contact/verify` and `/contact/decision`.
   *
   * These stand in for an emailed link. The real flow puts the token in an email
   * the reporter receives, and there is no inbox in a development mock, so the
   * tokens live here and `fixtures.ts` publishes the well-known ones as
   * constants. A UI can therefore be developed against the whole double-opt-in
   * flow without a mail server, and when the backend lands the constant becomes a
   * read of a real inbox.
   */
  verificationTokens: Map<string, { issueId: string; email: string; expiresAt: string; used: boolean }>;
  decisionTokens: Map<string, { issueId: string; expiresAt: string; used: boolean }>;
  /** Reports keyed by tracking token, so `/tracked/**` can be token-gated. */
  trackedTokens: Map<string, string[]>;
  sequence: Record<'issue' | 'comment' | 'revision' | 'audit' | 'user' | 'duplicate' | 'trace', number>;
}

/** The live state. Treat as read-only outside the handlers. */
export let state: MockState;

/**
 * The mock's fixed "now".
 *
 * Every timestamp the mock writes comes from here rather than from `Date.now()`,
 * for one reason: the fixtures encode windows as facts - a comment created 25
 * minutes ago is still editable, one created 40 minutes ago is not, a resolution
 * closed 16 days ago is past its reopen deadline. If "now" were real time, those
 * outcomes would depend on the minute the suite ran, so a test would pass locally
 * and fail in CI, and a screenshot taken today would not match one taken next week.
 *
 * A consequence worth stating plainly: `applyTransition` does not move this clock,
 * so a report created and then resolved in the same session has both timestamps
 * equal. Nothing in the lifecycle depends on them differing, but a UI that renders
 * "resolved 0 minutes after you reported it" is reading a mock artefact, not a
 * behaviour.
 */
export const NOW = '2026-03-02T09:15:00.000Z';

/** Replace the world. Used by the seeder and by test reset. */
export function setState(next: MockState): void {
  state = next;
}

/**
 * Monotonic id generator, per kind.
 *
 * Separate walks rather than one counter so an id says what it is: `cmt-000004`
 * is obviously the fourth comment. Padded for the same reason - a fixture id that
 * changes on every reload is impossible to eyeball in a test failure.
 */
function nextId(kind: keyof MockState['sequence'], prefix: string, width = 6): string {
  state.sequence[kind] += 1;
  return `${prefix}-${String(state.sequence[kind]).padStart(width, '0')}`;
}

export function nextCommentId(): string {
  return nextId('comment', 'cmt');
}

/**
 * The next report's `id` and `publicCode`.
 *
 * `public_code` is documented as a dense walkable range and is what a share link is
 * built from, so two reports must never share one. The builder used to return the
 * same pair for every call, which made a duplicate invisible: a client that filed
 * twice got two responses with the same share URL and nothing anywhere could tell
 * the difference - the same class of bug as the idempotency cache being absent, one
 * layer down.
 *
 * Starts past the seeded fixtures, so a created report cannot collide with one the
 * mock ships with.
 */
export function nextIdForIssue(): { id: string; publicCode: string } {
  state.sequence.issue += 1;
  const n = String(state.sequence.issue).padStart(4, '0');
  return { id: `iss-mock-new-${n}`, publicCode: `CL-2026-${n}` };
}

/** Reset the created-report walk, so each test starts from the same state. */
export function resetCreatedReportSequence(): void {
  state.sequence.issue = 100;
}

export function nextRevisionId(): string {
  return nextId('revision', 'rev');
}

export function nextDuplicateId(): string {
  return nextId('duplicate', 'dup');
}

/** A UUID-shaped id, for the fields the contract types as `format: uuid`. */
export function mockUuid(kind: 'user' | 'audit'): string {
  const n = String(state.sequence[kind]).padStart(12, '0');
  return `00000000-0000-4000-8000-${n}`;
}

/**
 * Append to the audit trail.
 *
 * SPEC calls this "the record that answers 'the department never actioned my
 * report'" and marks it append-only: there is no update or delete path. This
 * being the only writer, and having no remover, is the point - a mock that let an
 * audit row be edited would model the one thing the real table forbids.
 *
 * `ipAddress` is `null` for any action on a concealed report. A reporter's IP is
 * the only identity such a report has, so keeping it in an admin-readable table
 * would leave the concealment one records request away.
 */
export function appendAudit(entry: {
  actorId: string | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string;
  oldValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  concealed?: boolean;
}): void {
  state.auditLogs.unshift({
    id: nextId('audit', 'aud'),
    actorId: entry.actorId,
    actorName: entry.actorName,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    oldValue: entry.oldValue ?? null,
    newValue: entry.newValue ?? null,
    ipAddress: entry.concealed ? null : '198.51.100.24',
    createdAt: NOW,
  });
}

/**
 * Apply a status transition, writing exactly one history row.
 *
 * SPEC: "Every allowed transition writes exactly one `issue_status_history` row."
 * A mock that moved `status` without appending would render a detail screen whose
 * timeline - embedded by the contract precisely so the UI can show it - showed no
 * history, so the screen would look finished while displaying nothing about how
 * the report got where it is.
 */
export function applyTransition(
  issue: StoredIssue,
  to: IssueStatus,
  actor: { userId: string | null; displayName: string },
  reason?: string | null,
): void {
  const from = issue.status;
  const at = issue.now;
  issue.status = to;
  issue.statusLabel = STATUS_LABELS[to];
  issue.updatedAt = at;

  issue.statusHistory = [
    ...(issue.statusHistory ?? []),
    {
      id: nextId('issue', 'ste'),
      fromStatus: from,
      toStatus: to,
      changedById: actor.userId,
      changedByName: actor.displayName,
      reason: reason ?? null,
      createdAt: at,
    },
  ];

  // REOPEN_WINDOW_DAYS is 14. Resolving sets the approval deadline to
  // resolvedAt + 14 days, and that deadline is the only thing bounding the
  // reporter's right to dispute. Modelling it is what lets a UI hide the reopen
  // button instead of offering one that 422s.
  if (to === 'RESOLVED') {
    issue.resolvedAt = at;
    issue.approvalDeadline = shiftDays(at, 14);
    issue.reopenWindowEndsAt = shiftDays(at, 14);
  }
  if (to === 'CLOSED') {
    issue.closedAt = at;
    issue.reopenWindowEndsAt = shiftDays(at, 14);
  }
  if (to === 'REOPENED' || to === 'IN_PROGRESS' || to === 'TRIAGED') {
    issue.resolvedAt = null;
    issue.approvalDeadline = null;
    if (to === 'REOPENED') {
      issue.reopenWindowEndsAt = null;
    }
  }
}

/** `REOPEN_WINDOW_DAYS` = 14, `COMMENT_EDIT_WINDOW_MINUTES` = 30 (SPEC 15). */
export const REOPEN_WINDOW_DAYS = 14;
export const COMMENT_EDIT_WINDOW_MINUTES = 30;

function shiftDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

function shiftMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

/**
 * `editWindowEndsAt`, or `null` once the window has passed or the caller is not
 * the author.
 *
 * Null is the point: the contract says the UI should hide the edit action rather
 * than show a button that will 422. So this returns null the moment the window is
 * gone, and the fixture's comment timestamps are what make that observable.
 */
export function editWindowEndsAt(comment: StoredComment, now: string, isAuthor: boolean): string | null {
  if (!isAuthor) {
    return null;
  }
  const ends = shiftMinutes(comment.createdAt, COMMENT_EDIT_WINDOW_MINUTES);
  return Date.parse(ends) > Date.parse(now) ? ends : null;
}

/** Whether an issue has open work. Gates department and category retirement. */
export function hasOpenIssues(issue: StoredIssue): boolean {
  return !['CLOSED', 'REJECTED', 'DUPLICATE', 'CANCELLED'].includes(issue.status);
}

export function userByEmail(email: string): StoredUser | undefined {
  const needle = email.trim().toLowerCase();
  return state.users.find((user) => user.email.toLowerCase() === needle);
}

export function userById(id: string): StoredUser | undefined {
  return state.users.find((user) => user.id === id);
}

/**
 * The account the mock mints a bearer for, given a role.
 *
 * Skips disabled users deliberately. A `DISABLED` staff member is the mock's
 * model of an abuse control (SPEC 77: users are soft-disabled, never deleted),
 * and a mock that kept letting a disabled user log in would make that control
 * untestable - the screen that shows "this account is disabled" could never be
 * reached.
 */
export function accountForRole(role: Role): CurrentUser | undefined {
  const user = state.users.find((c) => c.role === role && c.status === 'ACTIVE');
  return user ? asCurrentUser(user) : undefined;
}

/** The `User` projection. Drops the password and the self-registration flag. */
export function asUser(user: StoredUser): User {
  const { password: _password, selfRegistered: _selfRegistered, ...projection } = user;
  return projection;
}

/** The `CurrentUser` projection, which is `User` minus status and timestamps. */
export function asCurrentUser(user: StoredUser): CurrentUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    departmentId: user.departmentId,
    departmentName: user.departmentName,
  };
}

/** Register a user and return the stored form. */
export function addUser(input: {
  email: string;
  password: string;
  fullName: string;
  role: Role;
  departmentId?: string | null;
  phone?: string | null;
  selfRegistered: boolean;
}): StoredUser {
  const department = input.departmentId
    ? state.departments.find((candidate) => candidate.id === input.departmentId)
    : undefined;
  const user: StoredUser = {
    id: nextId('user', 'usr'),
    email: input.email,
    fullName: input.fullName,
    phone: input.phone ?? null,
    role: input.role,
    departmentId: input.departmentId ?? null,
    departmentName: department?.name ?? null,
    status: 'ACTIVE',
    createdAt: '2026-03-02T09:15:00.000Z',
    password: input.password,
    selfRegistered: input.selfRegistered,
  };
  state.users.push(user);
  return user;
}

/** Set a status, returning the previous value for the audit row. */
export function setUserStatus(user: StoredUser, status: UserStatus): UserStatus {
  const previous = user.status;
  user.status = status;
  return previous;
}

/**
 * An `ErrorEnvelope`, in the one style used across the mock.
 *
 * The `traceId` comes off a shared counter rather than a random string so that two
 * envelopes in one test failure carry *different* ids - a fixed value would make
 * "did the second request reach a handler, or did a guard answer first?"
 * unanswerable from the output.
 */
export function envelope(
  status: number,
  code: ErrorEnvelope['code'],
  message: string,
  path: string,
  details?: ErrorEnvelope['details'],
): ErrorEnvelope {
  state.sequence.trace += 1;
  return {
    timestamp: '2026-03-02T09:15:00.000Z',
    status,
    code,
    message,
    path,
    traceId: `mock-trace-${String(state.sequence.trace).padStart(6, '0')}`,
    ...(details ? { details } : {}),
  };
}
