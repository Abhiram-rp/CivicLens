import { http, HttpResponse } from 'msw';
import type {
  AuditLogPage,
  Category,
  CategoryRequest,
  Department,
  DepartmentRequest,
  SlaPolicy,
  SlaPolicyRequest,
  User,
  UserPage,
} from '../../app/api/generated/types.gen';
import {
  API,
  conflict,
  lengthViolations,
  malformedBody,
  notFound,
  page,
  readJson,
  requireRole,
  resolveCaller,
  validationError,
  type Caller,
} from '../http';
import {
  addUser,
  appendAudit,
  asUser,
  hasOpenIssues,
  setUserStatus,
  state,
  userByEmail,
  type StoredCategory,
  type StoredDepartment,
  type StoredSlaPolicy,
} from '../store';

/**
 * `/admin/**`: fourteen operations behind one role.
 *
 * ## Why this whole file is one module
 *
 * All fourteen are `security: [{ bearerAuth: [] }]` with ADMIN in the role list, so
 * they share one guard, one audit convention and one answer to "what happens when a
 * non-admin arrives": 403 about the *endpoint*, never 404 about a resource. The
 * 403-not-404 split is SPEC's rule and it is easy to lose when each handler writes
 * its own check; centralising it here is the only way to be sure all fourteen agree.
 *
 * ## The rules that are *not* obvious from the contract
 *
 * - **Retirement is guarded by open work.** A department or category with open
 *   issues cannot be set `active: false`. SPEC's reason is that history has to stay
 *   readable, and a retired department that still holds open reports is a report with
 *   nowhere to go - so the mock refuses the retirement rather than silently
 *   orphaning it. Retiring never deletes.
 * - **Role changes are audited with the old and new value.** A role change is the
 *   single most consequential row in the system, and "who was this person
 *   yesterday" is the question an audit exists to answer.
 * - **A user cannot disable themselves.** Otherwise the last admin can lock everyone
 *   out of `/admin/**` with two requests, and the recovery is a database console.
 * - **Staff need a department.** `FIELD_OFFICER` and `DEPARTMENT_MANAGER` without one
 *   cannot be assigned anything, so the mock refuses the account rather than creating
 *   a user who can do nothing.
 */

/** Every operation in this file. */
const ADMIN: readonly ('ADMIN')[] = ['ADMIN'];

/** `requireRole` for the admin tree, returning the guard or the caller. */
function admin(caller: Caller, path: string): { caller: Caller } | Response {
  const denied = requireRole(caller, ADMIN, path);
  return denied ?? { caller };
}

/**
 * `GET /admin/users`.
 *
 * `staffCount` is added here and nowhere else - the contract says it is "present on
 * the admin endpoint only" - because it is a headcount of a department and an
 * authenticated admin managing staff is the audience for it.
 */
function listUsers(request: Request): Response {
  const path = new URL(request.url).pathname;
  const gate = admin(resolveCaller(request), path);
  if (gate instanceof Response) {
    return gate;
  }

  const url = new URL(request.url);
  const role = url.searchParams.get('role');
  const departmentId = url.searchParams.get('departmentId');
  const status = url.searchParams.get('status');

  const filtered = state.users.filter((user) => {
    if (role && user.role !== role) {
      return false;
    }
    if (departmentId && user.departmentId !== departmentId) {
      return false;
    }
    if (status && user.status !== status) {
      return false;
    }
    return true;
  });

  // `asUser` drops the password and the self-registration flag, so the projection is
  // the only way a `User` can reach a response. Building the object inline here
  // instead would be one more place to forget.
  const content: User[] = filtered.map((user) => ({
    ...asUser(user),
    staffCount:
      user.departmentId === null
        ? undefined
        : state.users.filter(
            (candidate) => candidate.departmentId === user.departmentId && candidate.status === 'ACTIVE',
          ).length,
  }));
  const payload: UserPage = { ...page(content), page: numberParam(url, 'page', 0), size: numberParam(url, 'size', content.length || 1) };
  return HttpResponse.json(payload);
}

/** `POST /admin/users`. */
async function createUser(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const gate = admin(resolveCaller(request), path);
  if (gate instanceof Response) {
    return gate;
  }

  const body = await readJson<Parameters<typeof addUser>[0]>(request);
  if (!body) {
    return malformedBody(path);
  }

  const problems = [
    ...lengthViolations(body as Record<string, unknown>, {
      email: { maxLength: 254 },
      fullName: { minLength: 2, maxLength: 120 },
      password: { minLength: 10, maxLength: 128 },
    }),
  ];
  if (body.email && !body.email.includes('@')) {
    problems.push({ field: 'email', issue: 'Must be an email address.' });
  }
  // Explicit, rather than falling out of `addUser`: this is the field a careless
  // caller leaves out, and the message has to say which one.
  if (body.role !== 'CITIZEN' && body.role !== 'FIELD_OFFICER' && body.role !== 'DEPARTMENT_MANAGER' && body.role !== 'ADMIN') {
    problems.push({ field: 'role', issue: 'Must be one of CITIZEN, FIELD_OFFICER, DEPARTMENT_MANAGER, ADMIN.' });
  }
  if ((body.role === 'FIELD_OFFICER' || body.role === 'DEPARTMENT_MANAGER') && !body.departmentId) {
    problems.push({ field: 'departmentId', issue: 'Required for FIELD_OFFICER and DEPARTMENT_MANAGER.' });
  }
  if (body.departmentId && !state.departments.some((department) => department.id === body.departmentId)) {
    problems.push({ field: 'departmentId', issue: 'No such department.' });
  }
  if (body.email && userByEmail(body.email)) {
    // 409, matching registration: the address exists, which is a different fact from
    // the body being invalid.
    return conflict(path, 'That email address is already registered.');
  }
  if (problems.length > 0) {
    return validationError(path, 'The user is not valid.', problems);
  }

  // `selfRegistered: false` is what distinguishes an admin-created staff account from
  // one a citizen signed up for. The flag is never exposed, so the only way it is
  // observable is here - and it matters, because self-service registration is the
  // path that hard-codes CITIZEN.
  const user = addUser({ ...body, selfRegistered: false });

  appendAudit({
    actorId: gate.caller.userId,
    actorName: gate.caller.displayName,
    action: 'USER_CREATED',
    entityType: 'User',
    entityId: user.id,
    newValue: { role: user.role, departmentId: user.departmentId },
  });

  return HttpResponse.json(asUser(user), { status: 201 });
}

/** `PUT /admin/users/{userId}/role`. */
async function changeUserRole(request: Request, userId: string): Promise<Response> {
  const path = new URL(request.url).pathname;
  const gate = admin(resolveCaller(request), path);
  if (gate instanceof Response) {
    return gate;
  }

  const user = state.users.find((candidate) => candidate.id === userId);
  if (!user) {
    return notFound(path);
  }

  const body = await readJson<{ role?: User['role'] }>(request);
  const role = body?.role;
  if (role !== 'CITIZEN' && role !== 'FIELD_OFFICER' && role !== 'DEPARTMENT_MANAGER' && role !== 'ADMIN') {
    return validationError(path, 'A role is required.', [
      { field: 'role', issue: 'Must be one of CITIZEN, FIELD_OFFICER, DEPARTMENT_MANAGER, ADMIN.' },
    ]);
  }

  // A demotion that leaves the caller with no admin left is refused rather than
  // allowed. The last admin demoting themselves is otherwise a two-request lockout
  // with no recovery short of the database.
  if (user.role === 'ADMIN' && role !== 'ADMIN' && adminCount() <= 1) {
    return conflict(path, 'The last remaining admin cannot change their own role.');
  }

  const previous = { role: user.role, departmentId: user.departmentId };
  user.role = role;
  // A citizen has no department, and a staff member without one cannot be assigned
  // anything - so a move to CITIZEN clears it rather than leaving a dangling id
  // that still passes a "is this officer in my department" check.
  if (role === 'CITIZEN') {
    user.departmentId = null;
    user.departmentName = null;
  }

  appendAudit({
    actorId: gate.caller.userId,
    actorName: gate.caller.displayName,
    // The action name the contract's audit docs list.
    action: 'USER_ROLE_CHANGED',
    entityType: 'User',
    entityId: user.id,
    oldValue: previous,
    newValue: { role: user.role, departmentId: user.departmentId },
  });

  return HttpResponse.json(asUser(user));
}

/** `PUT /admin/users/{userId}/status`. */
async function changeUserStatus(request: Request, userId: string): Promise<Response> {
  const path = new URL(request.url).pathname;
  const gate = admin(resolveCaller(request), path);
  if (gate instanceof Response) {
    return gate;
  }

  const user = state.users.find((candidate) => candidate.id === userId);
  if (!user) {
    return notFound(path);
  }

  const body = await readJson<{ status?: 'ACTIVE' | 'DISABLED' }>(request);
  const status = body?.status;
  if (status !== 'ACTIVE' && status !== 'DISABLED') {
    return validationError(path, 'A status is required.', [
      { field: 'status', issue: 'Must be ACTIVE or DISABLED.' },
    ]);
  }

  // Self-disable refused. Same reason as the last-admin rule, and it is the more
  // likely accident: an admin deactivates the row they are sitting on.
  if (user.id === gate.caller.userId && status === 'DISABLED') {
    return conflict(path, 'You cannot disable your own account.');
  }
  if (user.role === 'ADMIN' && status === 'DISABLED' && adminCount() <= 1) {
    return conflict(path, 'The last remaining admin cannot be disabled.');
  }

  const previous = setUserStatus(user, status);
  appendAudit({
    actorId: gate.caller.userId,
    actorName: gate.caller.displayName,
    action: 'USER_STATUS_CHANGED',
    entityType: 'User',
    entityId: user.id,
    oldValue: { status: previous },
    newValue: { status },
  });

  return HttpResponse.json(asUser(user));
}

/** Active admins, for the two "do not lock everyone out" guards above. */
function adminCount(): number {
  return state.users.filter((user) => user.role === 'ADMIN' && user.status === 'ACTIVE').length;
}

/** A query parameter as a number, or a default. Guards against `?page=abc`. */
function numberParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

// --- departments -------------------------------------------------------------------------------

/**
 * `GET /admin/departments`.
 *
 * Unlike `/reference/departments` this returns **retired** departments too, with
 * `staffCount`. The distinction is the point of having both: the reference endpoint
 * feeds pickers, the admin endpoint feeds management, and a manager who cannot see
 * a retired department cannot un-retire it.
 */
function listDepartments(request: Request): Response {
  const path = new URL(request.url).pathname;
  const gate = admin(resolveCaller(request), path);
  if (gate instanceof Response) {
    return gate;
  }
  const rows: Department[] = state.departments.map((department) => ({
    ...department,
    staffCount: state.users.filter(
      (user) => user.departmentId === department.id && user.status === 'ACTIVE',
    ).length,
  }));
  return HttpResponse.json(rows);
}

/** `POST /admin/departments`. */
async function createDepartment(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const gate = admin(resolveCaller(request), path);
  if (gate instanceof Response) {
    return gate;
  }

  const body = await readJson<DepartmentRequest>(request);
  if (!body) {
    return malformedBody(path);
  }
  const problems = departmentProblems(body);
  if (problems.length > 0) {
    return validationError(path, 'The department is not valid.', problems);
  }
  if (state.departments.some((department) => department.code === body.code)) {
    // 409 rather than 400: the code is unique, and a duplicate is a collision with
    // an existing row rather than a malformed value.
    return conflict(path, `A department with the code ${body.code} already exists.`);
  }

  const department: StoredDepartment = {
    id: `dept-${slug(body.code)}`,
    name: body.name,
    code: body.code,
    description: body.description ?? null,
    active: body.active ?? true,
    staffCount: 0,
  };
  state.departments.push(department);

  appendAudit({
    actorId: gate.caller.userId,
    actorName: gate.caller.displayName,
    action: 'DEPARTMENT_CREATED',
    entityType: 'Department',
    entityId: department.id,
    newValue: { code: department.code, active: department.active },
  });

  return HttpResponse.json(department, { status: 201 });
}

/** `PUT /admin/departments/{departmentId}`. */
async function updateDepartment(request: Request, departmentId: string): Promise<Response> {
  const path = new URL(request.url).pathname;
  const gate = admin(resolveCaller(request), path);
  if (gate instanceof Response) {
    return gate;
  }

  const department = state.departments.find((candidate) => candidate.id === departmentId);
  if (!department) {
    return notFound(path);
  }
  const body = await readJson<DepartmentRequest>(request);
  if (!body) {
    return malformedBody(path);
  }
  const problems = departmentProblems(body);
  if (problems.length > 0) {
    return validationError(path, 'The department is not valid.', problems);
  }

  // The retirement guard. SPEC: `active: false` means "gone from the reference list
  // and unassignable, but every issue already routed to it keeps its history", and
  // it "cannot be set false while the department holds open issues" - because a
  // retired department with open reports is reports with nowhere to go.
  if (body.active === false && department.active && openIssueCountFor('department', department.id) > 0) {
    return conflict(path, 'A department holding open issues cannot be retired.');
  }

  const previous = { name: department.name, code: department.code, active: department.active };
  department.name = body.name;
  department.code = body.code;
  department.description = body.description ?? null;
  department.active = body.active ?? true;

  appendAudit({
    actorId: gate.caller.userId,
    actorName: gate.caller.displayName,
    action: 'DEPARTMENT_UPDATED',
    entityType: 'Department',
    entityId: department.id,
    oldValue: previous,
    newValue: { name: department.name, code: department.code, active: department.active },
  });

  return HttpResponse.json(department);
}

function departmentProblems(body: DepartmentRequest): { field: string; issue: string }[] {
  const problems = lengthViolations(body as Record<string, unknown>, {
    name: { minLength: 2, maxLength: 120 },
    code: { minLength: 2, maxLength: 32 },
    description: { maxLength: 500 },
  });
  if (!body.code) {
    problems.push({ field: 'code', issue: 'Required, and unique.' });
  }
  return problems;
}

// --- categories -------------------------------------------------------------------------------

/** `GET /admin/categories`. Retired categories included - see departments. */
function listCategories(request: Request): Response {
  const path = new URL(request.url).pathname;
  const gate = admin(resolveCaller(request), path);
  if (gate instanceof Response) {
    return gate;
  }
  return HttpResponse.json(state.categories);
}

/** `POST /admin/categories`. */
async function createCategory(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const gate = admin(resolveCaller(request), path);
  if (gate instanceof Response) {
    return gate;
  }

  const body = await readJson<CategoryRequest>(request);
  if (!body) {
    return malformedBody(path);
  }
  const problems = categoryProblems(body);
  if (problems.length > 0) {
    return validationError(path, 'The category is not valid.', problems);
  }
  if (state.categories.some((category) => category.code === body.code)) {
    return conflict(path, `A category with the code ${body.code} already exists.`);
  }
  if (body.parentCategoryId && !state.categories.some((category) => category.id === body.parentCategoryId)) {
    return validationError(path, 'The category is not valid.', [
      { field: 'parentCategoryId', issue: 'No such parent category.' },
    ]);
  }

  const category: StoredCategory = {
    id: `cat-${slug(body.code)}`,
    name: body.name,
    code: body.code,
    parentCategoryId: body.parentCategoryId ?? null,
    defaultDepartmentId: body.defaultDepartmentId ?? null,
    active: body.active ?? true,
    subcategories: [],
  };
  state.categories.push(category);

  appendAudit({
    actorId: gate.caller.userId,
    actorName: gate.caller.displayName,
    action: 'CATEGORY_CREATED',
    entityType: 'Category',
    entityId: category.id,
    newValue: { code: category.code, active: category.active },
  });

  return HttpResponse.json(category, { status: 201 });
}

/** `PUT /admin/categories/{categoryId}`. */
async function updateCategory(request: Request, categoryId: string): Promise<Response> {
  const path = new URL(request.url).pathname;
  const gate = admin(resolveCaller(request), path);
  if (gate instanceof Response) {
    return gate;
  }

  const category = state.categories.find((candidate) => candidate.id === categoryId);
  if (!category) {
    return notFound(path);
  }
  const body = await readJson<CategoryRequest>(request);
  if (!body) {
    return malformedBody(path);
  }
  const problems = categoryProblems(body);
  if (problems.length > 0) {
    return validationError(path, 'The category is not valid.', problems);
  }

  // Same guard as departments, and the same reason: open issues keep pointing here.
  if (body.active === false && category.active && openIssueCountFor('category', category.id) > 0) {
    return conflict(path, 'A category holding open issues cannot be retired.');
  }

  const previous = { name: category.name, code: category.code, active: category.active };
  category.name = body.name;
  category.code = body.code;
  category.parentCategoryId = body.parentCategoryId ?? null;
  category.defaultDepartmentId = body.defaultDepartmentId ?? null;
  category.active = body.active ?? true;

  appendAudit({
    actorId: gate.caller.userId,
    actorName: gate.caller.displayName,
    action: 'CATEGORY_UPDATED',
    entityType: 'Category',
    entityId: category.id,
    oldValue: previous,
    newValue: { name: category.name, code: category.code, active: category.active },
  });

  return HttpResponse.json(category);
}

function categoryProblems(body: CategoryRequest): { field: string; issue: string }[] {
  const problems = lengthViolations(body as Record<string, unknown>, {
    name: { minLength: 2, maxLength: 120 },
    code: { minLength: 2, maxLength: 32 },
  });
  if (!body.code) {
    problems.push({ field: 'code', issue: 'Required, and unique.' });
  }
  if (body.defaultDepartmentId && !state.departments.some((department) => department.id === body.defaultDepartmentId)) {
    problems.push({ field: 'defaultDepartmentId', issue: 'No such department.' });
  }
  return problems;
}

// --- SLA ---------------------------------------------------------------------------------------

/** `GET /admin/sla-policies`. */
function listSlaPolicies(request: Request): Response {
  const path = new URL(request.url).pathname;
  const gate = admin(resolveCaller(request), path);
  if (gate instanceof Response) {
    return gate;
  }
  return HttpResponse.json(state.slaPolicies);
}

/**
 * `PUT /admin/sla-policies`.
 *
 * An upsert keyed on `(categoryId, priority)` rather than on a path id, which is why
 * this is a `PUT` to the collection. The rule that is easy to get wrong: a
 * **shortening** a target needs a reason. A department can always be given more time,
 * because that can only help the department; quietly cutting a citizen's expected
 * response time is the kind of change that has to be deliberate and attributable.
 */
async function upsertSlaPolicy(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const gate = admin(resolveCaller(request), path);
  if (gate instanceof Response) {
    return gate;
  }

  const body = await readJson<SlaPolicyRequest & { reason?: string }>(request);
  if (!body) {
    return malformedBody(path);
  }

  const problems: { field: string; issue: string }[] = [];
  if (body.priority !== 'LOW' && body.priority !== 'MEDIUM' && body.priority !== 'HIGH' && body.priority !== 'CRITICAL') {
    problems.push({ field: 'priority', issue: 'Must be one of LOW, MEDIUM, HIGH, CRITICAL.' });
  }
  // One hour is the floor. A zero-hour target would mark every issue breached the
  // moment it was created, which is a broken SLA rather than a strict one.
  if (typeof body.resolveWithinHours !== 'number' || body.resolveWithinHours < 1 || body.resolveWithinHours > 2160) {
    problems.push({ field: 'resolveWithinHours', issue: 'Must be between 1 and 2160 hours.' });
  }
  if (body.categoryId && !state.categories.some((category) => category.id === body.categoryId)) {
    problems.push({ field: 'categoryId', issue: 'No such category.' });
  }
  if (problems.length > 0) {
    return validationError(path, 'The SLA policy is not valid.', problems);
  }

  const existing = state.slaPolicies.find(
    (policy) => policy.categoryId === (body.categoryId ?? null) && policy.priority === body.priority,
  );

  if (existing && body.resolveWithinHours < existing.resolveWithinHours && !body.reason) {
    return validationError(path, 'Shortening an SLA target requires a reason.', [
      { field: 'reason', issue: 'Required when reducing resolveWithinHours.' },
    ]);
  }

  const previous = existing
    ? { resolveWithinHours: existing.resolveWithinHours }
    : null;

  if (existing) {
    existing.resolveWithinHours = body.resolveWithinHours;
    appendAudit({
      actorId: gate.caller.userId,
      actorName: gate.caller.displayName,
      action: 'SLA_POLICY_UPDATED',
      entityType: 'SlaPolicy',
      entityId: existing.id,
      oldValue: previous,
      newValue: { resolveWithinHours: existing.resolveWithinHours, reason: body.reason ?? null },
    });
    return HttpResponse.json(existing satisfies SlaPolicy);
  }

  const category = state.categories.find((candidate) => candidate.id === body.categoryId);
  const policy: StoredSlaPolicy = {
    id: `sla-${body.priority.toLowerCase()}-${category?.id ?? 'default'}`,
    categoryId: body.categoryId ?? null,
    categoryName: category?.name ?? null,
    priority: body.priority,
    resolveWithinHours: body.resolveWithinHours,
  };
  state.slaPolicies.push(policy);

  appendAudit({
    actorId: gate.caller.userId,
    actorName: gate.caller.displayName,
    action: 'SLA_POLICY_CREATED',
    entityType: 'SlaPolicy',
    entityId: policy.id,
    newValue: { priority: policy.priority, resolveWithinHours: policy.resolveWithinHours },
  });

  return HttpResponse.json(policy);
}

// --- audit and export --------------------------------------------------------------------------

/**
 * `GET /admin/audit-logs`.
 *
 * Append-only, read-only. There is no write or delete path anywhere in this mock, and
 * that is deliberate: SPEC marks the table append-only because it is the record that
 * answers "the department never actioned my report". A mock that let an audit row be
 * edited would model the one thing the real table forbids.
 *
 * Filters are ANDed, and `from`/`to` are inclusive on both ends.
 */
function listAuditLogs(request: Request): Response {
  const path = new URL(request.url).pathname;
  const gate = admin(resolveCaller(request), path);
  if (gate instanceof Response) {
    return gate;
  }

  const url = new URL(request.url);
  const entityType = url.searchParams.get('entityType');
  const entityId = url.searchParams.get('entityId');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  const filtered = state.auditLogs.filter((entry) => {
    if (entityType && entry.entityType !== entityType) {
      return false;
    }
    if (entityId && entry.entityId !== entityId) {
      return false;
    }
    if (from && Date.parse(entry.createdAt) < Date.parse(from)) {
      return false;
    }
    if (to && Date.parse(entry.createdAt) > Date.parse(to)) {
      return false;
    }
    return true;
  });

  const payload: AuditLogPage = {
    ...page(filtered),
    page: numberParam(url, 'page', 0),
    size: numberParam(url, 'size', filtered.length || 1),
  };
  return HttpResponse.json(payload);
}

/**
 * `GET /admin/export/issues.csv`.
 *
 * Returns `text/csv`, not JSON - the contract's response type is `string` and the
 * endpoint is a `.csv` path, so a client that parses it with `JSON.parse` is testing
 * the wrong thing.
 *
 * The header row is the point of the endpoint. It is the projection a council officer
 * will open in a spreadsheet, so it carries exactly the fields an FOI-style extract
 * needs and nothing derived from concealed reports: no reporter, no contact address,
 * no coordinates. `disclosure` *is* included, because a column saying "concealed" is
 * what tells the recipient why the adjacent columns are empty.
 *
 * Quoting and CRLF are handled properly, because the fields are free text a reporter
 * typed: a title containing a comma or a quote must not shift every later column.
 */
function exportIssues(request: Request): Response {
  const path = new URL(request.url).pathname;
  const gate = admin(resolveCaller(request), path);
  if (gate instanceof Response) {
    return gate;
  }

  const url = new URL(request.url);
  const statuses = url.searchParams.getAll('status');
  const createdFrom = url.searchParams.get('createdFrom');
  const createdTo = url.searchParams.get('createdTo');

  const rows = state.issues.filter((issue) => {
    if (statuses.length > 0 && !statuses.includes(issue.status)) {
      return false;
    }
    if (createdFrom && Date.parse(issue.createdAt) < Date.parse(createdFrom)) {
      return false;
    }
    if (createdTo && Date.parse(issue.createdAt) > Date.parse(createdTo)) {
      return false;
    }
    return true;
  });

  const header = [
    'public_code',
    'status',
    'category',
    'area',
    'title',
    'description',
    'disclosure',
    'created_at',
    'resolved_at',
    'closed_at',
    'confirmation_count',
    'photo_count',
  ];
  const lines = [header, ...rows.map((issue) => [issue.publicCode, issue.status, issue.categoryName ?? '', issue.areaLabel ?? '', issue.title, issue.description, issue.disclosure, issue.createdAt, issue.resolvedAt ?? '', issue.closedAt ?? '', String(issue.confirmationCount), String(issue.photoCount)])];

  // RFC 4180: double any embedded quote, wrap the field, join with CRLF.
  const csv = lines.map((line) => line.map(csvCell).join(',')).join('\r\n');

  return new HttpResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="civiclens-issues.csv"',
    },
  });
}

/** One CSV cell, quoted when it needs to be. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Open issues pointing at a department or a category. */
function openIssueCountFor(kind: 'department' | 'category', id: string): number {
  return state.issues.filter((issue) => {
    const matches = kind === 'department' ? issue.assignedDepartmentId === id : issue.categoryId === id;
    return matches && hasOpenIssues(issue);
  }).length;
}

/** `dept-ROADS_HIGHWAYS` -> `roads-highways`. */
function slug(code: string): string {
  return code.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export const adminHandlers = [
  http.get(`${API}/admin/users`, ({ request }) => listUsers(request)),
  http.post(`${API}/admin/users`, ({ request }) => createUser(request)),
  http.put(`${API}/admin/users/:userId/role`, ({ request, params }) => changeUserRole(request, String(params['userId']))),
  http.put(`${API}/admin/users/:userId/status`, ({ request, params }) =>
    changeUserStatus(request, String(params['userId'])),
  ),

  http.get(`${API}/admin/departments`, ({ request }) => listDepartments(request)),
  http.post(`${API}/admin/departments`, ({ request }) => createDepartment(request)),
  http.put(`${API}/admin/departments/:departmentId`, ({ request, params }) =>
    updateDepartment(request, String(params['departmentId'])),
  ),

  http.get(`${API}/admin/categories`, ({ request }) => listCategories(request)),
  http.post(`${API}/admin/categories`, ({ request }) => createCategory(request)),
  http.put(`${API}/admin/categories/:categoryId`, ({ request, params }) =>
    updateCategory(request, String(params['categoryId'])),
  ),

  http.get(`${API}/admin/sla-policies`, ({ request }) => listSlaPolicies(request)),
  http.put(`${API}/admin/sla-policies`, ({ request }) => upsertSlaPolicy(request)),

  http.get(`${API}/admin/audit-logs`, ({ request }) => listAuditLogs(request)),
  http.get(`${API}/admin/export/issues.csv`, ({ request }) => exportIssues(request)),
];

