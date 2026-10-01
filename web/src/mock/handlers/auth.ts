import { http, HttpResponse } from 'msw';
import type { DevicePlatform, RegisteredUser, RegisterRequest } from '../../app/api/generated/types.gen';
import {
  API,
  conflict,
  lengthViolations,
  malformedBody,
  readJson,
  rejectUnexpectedBearer,
  requireRole,
  resolveCaller,
  validationError,
} from '../http';
import { addUser, appendAudit, state, userByEmail } from '../store';

/**
 * `POST /auth/register` and the `/devices/**` tree.
 *
 * Deliberately does *not* contain login, refresh or logout: those three already
 * live in `handlers.ts` and MSW resolves a duplicated route to whichever
 * registration it saw first, silently. Two handlers claiming one path is a bug
 * that type-checks and passes every test that only exercises one of them, so each
 * operation is owned by exactly one module and composed once in `handlers.ts`.
 */

/** Every role that may hold a device token, since any signed-in caller may. */
const ANY_ROLE = ['CITIZEN', 'FIELD_OFFICER', 'DEPARTMENT_MANAGER', 'ADMIN'] as const;

/**
 * `POST /auth/register`.
 *
 * Self-service registration, and the one endpoint where the *absence* of a role
 * field is the security property. `RegisterRequest` has no `role`, so a body
 * carrying one is not a privileged request, it is a malformed one - and the mock
 * rejects it rather than ignoring it, because a client that sends
 * `role: 'ADMIN'` and receives a 201 has been told it is an admin and will build
 * UI on that belief until somebody reads the production logs.
 *
 * The created user is `CITIZEN` unconditionally. There is no code path here that
 * could make it otherwise, which is the point: the role is a literal in the
 * projection, not a value read from the request.
 */
async function register(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const unexpected = rejectUnexpectedBearer(request);
  if (unexpected) {
    return unexpected;
  }

  const body = await readJson<RegisterRequest>(request);
  if (!body) {
    return malformedBody(path);
  }

  // Read through an index signature because the field is *absent* from
  // `RegisterRequest`: TypeScript is right that it is not part of the request, and
  // the check exists precisely to catch a client that sent one anyway.
  const smuggled = (body as Record<string, unknown>)['role'];
  if (smuggled !== undefined) {
    return validationError(path, 'A registration may not choose a role.', [
      { field: 'role', issue: 'Self-service registration always creates a CITIZEN.' },
    ]);
  }

  const problems: { field: string; issue: string }[] = [];
  if (!body.email || !body.email.includes('@')) {
    problems.push({ field: 'email', issue: 'Must be an email address.' });
  }
  if (!body.password || body.password.length < 10) {
    problems.push({ field: 'password', issue: 'Must be at least 10 characters.' });
  }
  if (!body.fullName || body.fullName.length < 2) {
    problems.push({ field: 'fullName', issue: 'Must be at least 2 characters.' });
  }
  const tooLong = lengthViolations(body as Record<string, unknown>, {
    email: { maxLength: 254 },
    fullName: { maxLength: 120 },
  });
  if (problems.length === 0) {
    problems.push(...tooLong);
  }
  if (problems.length > 0) {
    return validationError(path, 'The registration is not valid.', problems);
  }

  // 409, not 400. "The address is taken" is a different fact from "the request is
  // malformed", and it is also the only place the endpoint confirms an address
  // exists - so the message is fixed rather than echoing what collided.
  if (userByEmail(body.email)) {
    return conflict(path, 'That email address is already registered.');
  }

  const user = addUser({
    email: body.email,
    password: body.password,
    fullName: body.fullName,
    role: 'CITIZEN',
    phone: body.phone ?? null,
    selfRegistered: true,
  });

  appendAudit({
    actorId: user.id,
    actorName: user.fullName,
    action: 'USER_REGISTERED',
    entityType: 'User',
    entityId: user.id,
    newValue: { role: 'CITIZEN', selfRegistered: true },
  });

  // `RegisteredUser`: no status, no timestamps, and - the contract's emphatic
  // point - no password. The literal below is the enforcement, so a future change
  // to `addUser` cannot leak the hash into a response by forgetting to strip it.
  const projection: RegisteredUser = {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: 'CITIZEN',
  };
  return HttpResponse.json(projection, { status: 201 });
}

/** The platforms the contract's `DevicePlatform` allows. */
const PLATFORMS: readonly DevicePlatform[] = ['ANDROID', 'IOS', 'WEB'];

/**
 * `POST /devices/register`.
 *
 * The row is stored and **nothing is dispatched**. SPEC says exactly that for
 * P1, which makes a registration that produced no push notification faithful
 * rather than incomplete - and it is worth being explicit, because the tempting
 * alternative is to fake a delivery and end up with a UI that believes pushes
 * work.
 *
 * Idempotent on the token rather than on the caller: a device reinstalls, presents
 * the same token, and must not accumulate rows.
 */
async function registerDevice(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const caller = resolveCaller(request);
  const denied = requireRole(caller, ANY_ROLE, path);
  if (denied) {
    return denied;
  }

  const body = await readJson<{ token?: string; platform?: DevicePlatform }>(request);
  if (!body) {
    return malformedBody(path);
  }
  if (!body.token || !PLATFORMS.includes(body.platform as DevicePlatform)) {
    return validationError(path, 'A device token and a supported platform are required.', [
      { field: !body.token ? 'token' : 'platform', issue: 'Required.' },
    ]);
  }

  const existing = state.deviceTokens.find((row) => row.token === body.token);
  if (existing) {
    // Re-registration by a different account is the one case worth refusing: the
    // token would otherwise silently start delivering to the wrong person, which
    // is a cross-account leak rather than a duplicate row.
    if (existing.userId !== caller.userId) {
      return conflict(path, 'That device token is already registered to another account.');
    }
    return new HttpResponse(null, { status: 204 });
  }

  state.deviceTokens.push({
    token: body.token,
    platform: body.platform as DevicePlatform,
    userId: caller.userId!,
  });
  return new HttpResponse(null, { status: 204 });
}

/**
 * `POST /devices/unregister`.
 *
 * Idempotent, and deliberately so: unregistering a token that is already gone is
 * the normal state after a reinstall or a sign-out on another device, and
 * answering 404 would make a client's "clear it locally either way" path look like
 * a failure worth retrying.
 */
async function unregisterDevice(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const caller = resolveCaller(request);
  const denied = requireRole(caller, ANY_ROLE, path);
  if (denied) {
    return denied;
  }

  const body = await readJson<{ token?: string }>(request);
  if (!body) {
    return malformedBody(path);
  }
  if (!body.token) {
    return validationError(path, 'A device token is required.', [{ field: 'token', issue: 'Required.' }]);
  }

  state.deviceTokens = state.deviceTokens.filter(
    (row) => row.token !== body.token || row.userId !== caller.userId,
  );
  return new HttpResponse(null, { status: 204 });
}

export const authHandlers = [
  http.post(`${API}/auth/register`, ({ request }) => register(request)),
  http.post(`${API}/devices/register`, ({ request }) => registerDevice(request)),
  http.post(`${API}/devices/unregister`, ({ request }) => unregisterDevice(request)),
];
