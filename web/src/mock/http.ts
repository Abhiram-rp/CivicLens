import { HttpResponse } from 'msw';
import type { ErrorEnvelope, IssueStatus, Role } from '../app/api/generated/types.gen';
import {
  asCurrentUser,
  envelope,
  state,
  userById,
  type StoredIssue,
  type StoredUser,
} from './store';

/**
 * Credential resolution and the four rejection shapes every handler needs.
 *
 * Centralised because the *difference* between these responses is the contract's
 * security model, and a handler that inlines its own version of "not allowed"
 * starts inventing one. SPEC 3 draws the line precisely:
 *
 * - **403** only when the caller's role could never use that endpoint at all. A
 *   `CITIZEN` on `/admin/users` is 403; the role is simply not in the operation's
 *   vocabulary.
 * - **404** for any resource the caller cannot see, *including* sub-resources.
 *   This is the rule that stops an enumeration: if a citizen who is not the
 *   reporter gets 403 on someone else's report, the status code alone confirms
 *   the report exists.
 *
 * Getting this backwards is the most common way a mock stops being a rehearsal:
 * a UI built against a mock that 403s where the server 404s learns to render a
 * "you do not have access" screen for a resource that does not exist, which is
 * both a worse experience and an information leak.
 */

export const API = '*/api/v1';

/** The caller behind a request, resolved from whichever credential it carries. */
export interface Caller {
  role: Role | null;
  userId: string | null;
  displayName: string;
  /** Set when the request authenticated with a tracking token, not a session. */
  trackingToken: string | null;
  user: StoredUser | null;
}

export const ANONYMOUS: Caller = {
  role: null,
  userId: null,
  displayName: 'anonymous',
  trackingToken: null,
  user: null,
};

/**
 * Pull the role out of a mock bearer: `mock-token-<role>`.
 *
 * A role-only bearer is a *mock* limitation and it is a real one: the contract's
 * identity is the user id, and two citizens share the `CITIZEN` role, so a bearer
 * shaped like this cannot answer "which citizen is this". Everything that needs a
 * per-citizen answer - idempotency scoping, comment authorship, "is this my
 * report" - therefore resolves through `resolveCaller`, which maps the role back
 * to the one seeded account per role. The mock gets away with exactly one
 * account per role; a real backend must put an id in the token.
 */
function roleFromToken(request: Request): Role | null {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer mock-token-')) {
    return null;
  }
  const role = auth.slice('Bearer mock-token-'.length);
  return isRole(role) ? role : null;
}

function isRole(value: string): value is Role {
  return ['CITIZEN', 'FIELD_OFFICER', 'DEPARTMENT_MANAGER', 'ADMIN'].includes(value);
}

/**
 * The caller behind a request.
 *
 * Checks the session first and the tracking token second, and returns the tracking
 * token as an identity rather than treating the two as interchangeable. The two
 * credentials open two different trees, and a request carrying both is a bug in
 * the client's interceptor rather than a session, so it is reported as such.
 */
export function resolveCaller(request: Request): Caller {
  const bearer = request.headers.get('Authorization');
  const trackingToken = request.headers.get('X-Tracking-Token');

  if (bearer) {
    const role = roleFromToken(request);
    if (!role) {
      return ANONYMOUS;
    }
    const user = state.users.find((candidate) => candidate.role === role && candidate.status === 'ACTIVE');
    if (!user) {
      return ANONYMOUS;
    }
    return {
      role: user.role,
      userId: user.id,
      displayName: user.fullName,
      trackingToken,
      user,
    };
  }

  if (trackingToken) {
    return { role: null, userId: null, displayName: 'concealed reporter', trackingToken, user: null };
  }

  return ANONYMOUS;
}

/**
 * One field-level problem, as the contract's `FieldError` allows it.
 *
 * Declared here, with both members *required*, because the generated
 * `FieldError` has them optional and every producer in this mock has both. The
 * looseness costs more than it buys: a handler building a `FieldError` with a
 * missing `field` type-checks and produces a 400 whose detail array the UI cannot
 * attach to an input, which renders as "something was wrong" with no field
 * highlighted. A strict local shape makes that impossible, and it is assignable to
 * the loose contract type on the way out.
 */
export interface FieldProblem {
  field: string;
  issue: string;
}

/** 401. No usable credential at all. */
export function unauthenticated(path: string, message = 'Authentication required.'): HttpResponse<ErrorEnvelope> {
  return HttpResponse.json(envelope(401, 'UNAUTHENTICATED', message, path), { status: 401 });
}

/**
 * 403. The role could never use this endpoint.
 *
 * Deliberately about the *endpoint*, never about the resource. Anything
 * resource-shaped is `notFound`.
 */
export function forbidden(path: string, message = 'You do not have access to this resource.'): HttpResponse<ErrorEnvelope> {
  return HttpResponse.json(envelope(403, 'FORBIDDEN', message, path), { status: 403 });
}

/** 404. Absent, or invisible to this caller - and the two must look identical. */
export function notFound(path: string, message = 'Not found.'): HttpResponse<ErrorEnvelope> {
  return HttpResponse.json(envelope(404, 'NOT_FOUND', message, path), { status: 404 });
}

/** 409. A permitted operation on a resource in the wrong state. */
export function conflict(path: string, message: string): HttpResponse<ErrorEnvelope> {
  return HttpResponse.json(envelope(409, 'INVALID_STATE_TRANSITION', message, path), { status: 409 });
}

export function gone(path: string, message: string): HttpResponse<ErrorEnvelope> {
  return HttpResponse.json(envelope(410, 'VALIDATION_ERROR', message, path), { status: 410 });
}

export function unprocessable(path: string, message: string): HttpResponse<ErrorEnvelope> {
  return HttpResponse.json(envelope(422, 'VALIDATION_ERROR', message, path), { status: 422 });
}

/** 400, with per-field detail where the field is the problem. */
export function validationError(
  path: string,
  message: string,
  details?: FieldProblem[],
): HttpResponse<ErrorEnvelope> {
  return HttpResponse.json(envelope(400, 'VALIDATION_ERROR', message, path, details), { status: 400 });
}

/**
 * The guard for an operation's declared roles.
 *
 * Returns a 403 response or `null`, so a handler reads:
 *
 * ```ts
 * const denied = requireRole(caller, ['ADMIN'], path);
 * if (denied) return denied;
 * ```
 *
 * One call rather than an inline `if (!caller.role.includes(...))`, because the
 * difference between "no credential" (401) and "wrong credential" (403) is the
 * difference between a client that should retry and one that should give up, and
 * it is easy to lose when the check is written by hand each time.
 */
export function requireRole(caller: Caller, roles: readonly Role[], path: string): HttpResponse<ErrorEnvelope> | null {
  if (!caller.userId && !caller.trackingToken) {
    return unauthenticated(path);
  }
  if (caller.role === null || !roles.includes(caller.role)) {
    return forbidden(path, `This endpoint requires one of: ${roles.join(', ')}.`);
  }
  return null;
}

/**
 * The `/auth/**`, `/public/**` and `/tracked/**` credential rules.
 *
 * Three different rules, one function per tree, because "reject the wrong
 * credential" means something different in each:
 *
 * - `/auth/**` and `/public/**` carry `security: []`. A bearer arriving here is a
 *   client bug, and 400 says "this request is malformed" rather than 403, which
 *   would read as "your role is not allowed" on an endpoint no role is allowed on.
 * - `/tracked/**` is authenticated by the token and *only* by the token. A session
 *   bearer is refused, because the tree's whole purpose is that a leaked tracking
 *   token is the only thing that opens it; accepting a session too would mean a
 *   signed-in citizen could read reports they have no token for.
 */
export function rejectUnexpectedBearer(request: Request): HttpResponse<ErrorEnvelope> | null {
  if (request.headers.has('Authorization')) {
    const path = new URL(request.url).pathname;
    return HttpResponse.json(
      envelope(400, 'VALIDATION_ERROR', 'This endpoint does not accept an Authorization header.', path),
      { status: 400 },
    );
  }
  return null;
}

/** The tracked-tree refusal, for the specific case of a session on `/tracked/**`. */
export function rejectSessionOnTracked(request: Request): HttpResponse<ErrorEnvelope> | null {
  if (request.headers.has('Authorization')) {
    const path = new URL(request.url).pathname;
    return forbidden(path, '/tracked/** is authenticated by the tracking token, not a session.');
  }
  return null;
}

/**
 * The tracking token's own check.
 *
 * The failure modes are deliberately asymmetric, and getting them the wrong way
 * round is the mistake this function exists to prevent:
 *
 * - **missing** header -> 401. There is no credential, so the client should ask for
 *   one rather than report a broken link.
 * - **present but unrecognised** -> 404, *not* 403. A 403 would confirm the token
 *   was well-formed but unknown, while 404 makes "this link is not valid" and "no
 *   such report" the same answer. SPEC calls this out directly: the reporter's most
 *   likely moment to click a stale link is after they reinstalled the app, and the
 *   client should render one state, not two.
 */
export function requireTrackingToken(request: Request): { token: string } | HttpResponse<ErrorEnvelope> {
  const path = new URL(request.url).pathname;
  const session = rejectSessionOnTracked(request);
  if (session) {
    return session;
  }
  const token = request.headers.get('X-Tracking-Token');
  if (!token) {
    return unauthenticated(path, 'A tracking token is required.');
  }
  if (!state.trackedTokens.has(token)) {
    return notFound(path, 'This link is not valid.');
  }
  return { token };
}

/** The `/tracked/**` lookup, honouring the 404-not-403 rule within the token's scope. */
export function trackedIssueFor(token: string, issueId: string): StoredIssue | undefined {
  const ids = state.trackedTokens.get(token) ?? [];
  if (!ids.includes(issueId)) {
    return undefined;
  }
  return state.issues.find((issue) => issue.id === issueId);
}

/**
 * Whether the caller is the report's reporter.
 *
 * True for a session whose id matches, and also for a request holding the token
 * that owns the report - which is what makes `/tracked/**` and the session path
 * interchangeable for closing and reopening. SPEC 4 requires exactly that: the two
 * transports write the same history row and the same audit action, so the
 * lifecycle does not branch on disclosure.
 */
export function isReporter(caller: Caller, issue: StoredIssue): boolean {
  if (caller.trackingToken) {
    return (state.trackedTokens.get(caller.trackingToken) ?? []).includes(issue.id);
  }
  return issue.reporterId !== null && caller.userId === issue.reporterId;
}

/**
 * The reporter's identity, for staff who need to contact them about this report.
 *
 * Null when `disclosure` is CONCEALED *even for staff*. The contract says so
 * explicitly, and the reason is worth keeping in view when this function is next
 * edited: the reporter asked not to be identified, and no internal role is a
 * reason to override that.
 */
export function reporterNameFor(issue: StoredIssue): string | null {
  if (issue.disclosure === 'CONCEALED' || issue.reporterId === null) {
    return null;
  }
  return userById(issue.reporterId)?.fullName ?? null;
}

/** Whether the caller may see this issue at all, per SPEC 3's disclosure table. */
export function canSeeIssue(caller: Caller, issue: StoredIssue): boolean {
  if (caller.trackingToken) {
    return (state.trackedTokens.get(caller.trackingToken) ?? []).includes(issue.id);
  }
  if (!caller.userId) {
    return false;
  }
  if (isReporter(caller, issue)) {
    return true;
  }
  // Staff see reports; a concealed one just does not come with a name.
  return caller.role === 'FIELD_OFFICER' || caller.role === 'DEPARTMENT_MANAGER' || caller.role === 'ADMIN';
}

/** Whether the caller may act on this issue as staff - department scope included. */
export function isStaffInScope(caller: Caller, issue: StoredIssue): boolean {
  if (caller.role === 'ADMIN') {
    return true;
  }
  if (caller.role === 'FIELD_OFFICER') {
    return caller.user?.departmentId === issue.assignedDepartmentId;
  }
  if (caller.role === 'DEPARTMENT_MANAGER') {
    // SPEC 78: P1 exercises a manager with a null department doing manual triage,
    // so a null manager department is a manager of everything rather than nothing.
    return caller.user?.departmentId === null || caller.user?.departmentId === issue.assignedDepartmentId;
  }
  return false;
}

/** Read a JSON body, tolerating an absent or unparseable one. */
export async function readJson<T>(request: Request): Promise<T | null> {
  try {
    const text = await request.text();
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

/** A 400 for a body that is not JSON at all, which is not the same as a bad field. */
export function malformedBody(path: string): HttpResponse<ErrorEnvelope> {
  return validationError(path, 'The request body could not be parsed as JSON.');
}

/**
 * Check a body field's length, as the contract's `minLength`/`maxLength` say.
 *
 * Copied from the contract by hand, because those bounds survive into the
 * generated types only as prose. The point of checking them here is that a mock
 * which accepts a 3-character title lets a reporter submit something the real
 * server rejects - losing a carefully typed report at the moment of submitting
 * it, having been told it worked.
 */
export function lengthViolations(
  body: Record<string, unknown>,
  rules: Record<string, { minLength?: number; maxLength: number }>,
): FieldProblem[] {
  const errors: FieldProblem[] = [];
  for (const [field, rule] of Object.entries(rules)) {
    const value = body[field];
    if (typeof value !== 'string') {
      continue;
    }
    if (rule.minLength !== undefined && value.length < rule.minLength) {
      errors.push({ field, issue: `Must be at least ${rule.minLength} characters.` });
    }
    if (value.length > rule.maxLength) {
      errors.push({ field, issue: `Must be at most ${rule.maxLength} characters.` });
    }
  }
  return errors;
}

/**
 * A page envelope, matching the contract's `totalPages`/`hasNext` pair.
 *
 * `totalPages` is always 1 because the mock never paginates: every list it returns
 * is the whole set. That is a real simplification rather than a rounding detail,
 * so it is stated in the shape - a UI built against this learns that `page` can be
 * sent back and will not narrow the result, which is the bug that only appears
 * against a server that honours it. Pagination becomes real when the mock gets
 * real data.
 */
export function page<T>(content: T[], pageNumber = 0, size = content.length || 1) {
  return {
    content,
    page: pageNumber,
    size,
    totalElements: content.length,
    totalPages: 1,
    hasNext: false,
  };
}

/** Whether a status is one a manager queue filters on. */
export function isOpenStatus(status: IssueStatus): boolean {
  return !['CLOSED', 'REJECTED', 'DUPLICATE', 'CANCELLED'].includes(status);
}

export { asCurrentUser };
