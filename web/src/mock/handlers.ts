import { http, HttpResponse } from 'msw';
import type {
  ErrorEnvelope,
  IssueCreateForm,
  IssueCreateResponse,
  ReporterContact,
} from '../app/api/generated/types.gen';
import {
  ACCOUNTS,
  CATEGORIES,
  ISSUES,
  MOCK_PASSWORD,
  MOCK_TRACKING_TOKEN,
  NOTIFICATIONS,
  PUBLIC_ISSUE,
  TRACKED_ISSUE,
    createdIssue,
    issuePage,
    notificationPage,
    registerTrackedReport,
    trackedDetailFor,
    trackedSummariesFor,
  } from './fixtures';
  import {
    deriveTrackingToken,
    fingerprintIssueCreate,
    idempotencyStore,
    isValidIdempotencyKey,
    recordIdempotencyMismatch,
    reporterIdentity,
  } from './idempotency';

/**
 * Development mock server.
 *
 * These handlers are deliberately not a happy-path stub. Each one reproduces the
 * *authorisation* rule from the contract, because a mock that answers every
 * request with 200 will happily develop a screen against a request the real
 * server rejects - and the screen then works in the demo and 403s in production.
 * The rules enforced here:
 *
 *   - `/tracked/**` accepts only `X-Tracking-Token`, and rejects a request that
 *     arrives with a session bearer instead. Two credentials for two trees.
 *   - `/public/**` and `/reference/**` reject an `Authorization` header. If a
 *     bearer is attached where the contract says `security: []`, that is a bug
 *     in `session-policy.ts` and the mock is where it shows up.
 *   - `/auth/**` rejects a bearer for the same reason.
 *   - Staff trees require a role, and the role comes from the token, not from
 *     the request body.
 *
 * Each rejection uses the contract's own `ErrorEnvelope`, including `traceId`,
 * so the error-handling path gets exercised rather than skipped.
 */

const API = '*/api/v1';

/**
 * Origin used to build the `publicShareUrl` in the create-issue response.
 *
 * The contract calls it an absolute URL, and a relative one would be useless to
 * a reporter who copies it into a message to a neighbour. Overridable so a
 * browser-driven test can assert against the origin it is actually served from
 * rather than string-matching a host.
 */
const PUBLIC_ORIGIN = 'https://civiclens.example.org';

let traceCounter = 0;

/** A form field's value, narrowed away from the `File` case. */
const text = (value: FormDataEntryValue | null): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value === '' ? undefined : value;
};

/**
 * The `POST /issues` request body, decoded from multipart.
 *
 * Typed as the contract's `IssueCreateForm` so this cannot drift from it, which
 * is the whole reason the handler does not build its own object literal. It
 * returns a *partial*: a body the client got wrong is not an error this parser
 * should raise, because the 400 that comes back has to be the contract's error
 * envelope with per-field details, and that is decided below.
 *
 * `latitude` and `longitude` are the two fields the contract types as `number`
 * and multipart delivers as text. `Number(...)` on an empty string yields `0`,
 * which is a real coordinate in the Gulf of Guinea, so the empty case is checked
 * explicitly and reported as absent rather than silently becoming null island.
 */
const parseIssueCreateForm = (form: FormData): Partial<IssueCreateForm> => {
  const contactType = text(form.get('reporterContact.type'));
  const contactValue = text(form.get('reporterContact.value'));
  // `ContactChannelType` is the single-member union `'EMAIL'`, so the value from
  // the form is narrowed against it rather than cast. An unrecognised channel is
  // dropped here, which surfaces to the client as the contract's
  // "contact channel required" 400 rather than as a mock-only complaint - the
  // real server has exactly one channel type, so agreeing with that is what makes
  // the mock a useful rehearsal.
  const reporterContact: ReporterContact | undefined =
    contactType === 'EMAIL' && contactValue ? { type: 'EMAIL', value: contactValue } : undefined;

  const coordinate = (name: 'latitude' | 'longitude'): number | undefined => {
    const raw = text(form.get(name));
    if (raw === undefined) {
      return undefined;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const note = text(form.get('contactDisclosureNote'));

  return {
    title: text(form.get('title')),
    description: text(form.get('description')),
    disclosure: text(form.get('disclosure')) as IssueCreateForm['disclosure'],
    reporterContact,
    // Narrowed to the contract's `'1'` literal rather than passed through, so a
    // client that sent the string `'yes'` does not satisfy a check the contract
    // describes as a constant marker.
    contactDisclosureNote: note === '1' ? '1' : undefined,
    categoryId: text(form.get('categoryId')),
    subcategoryId: text(form.get('subcategoryId')),
    proposedCategoryText: text(form.get('proposedCategoryText')),
    latitude: coordinate('latitude'),
    longitude: coordinate('longitude'),
    address: text(form.get('address')),
    // `photos` is a repeated field, so `get` would only ever see the first one.
    photos: form.getAll('photos').filter((entry): entry is File => entry instanceof File),
  };
};

function envelope(
  status: number,
  code: ErrorEnvelope['code'],
  message: string,
  path: string,
  details?: ErrorEnvelope['details'],
): ErrorEnvelope {
  return {
    timestamp: '2026-03-02T09:15:00.000Z',
    status,
    code,
    message,
    path,
    traceId: `mock-trace-${(++traceCounter).toString().padStart(6, '0')}`,
    ...(details ? { details } : {}),
  };
}

const unauthenticated = (path: string): HttpResponse<ErrorEnvelope> =>
  HttpResponse.json(envelope(401, 'UNAUTHENTICATED', 'Authentication required.', path), {
    status: 401,
  });

const forbidden = (path: string, message = 'You do not have access to this resource.'): HttpResponse<ErrorEnvelope> =>
  HttpResponse.json(envelope(403, 'FORBIDDEN', message, path), { status: 403 });

const notFound = (path: string, message = 'Not found.'): HttpResponse<ErrorEnvelope> =>
  HttpResponse.json(envelope(404, 'NOT_FOUND', message, path), { status: 404 });

  /** Pull the role out of a mock bearer: `mock-token-<role>`. */
  function roleFromToken(request: Request): string | null {
    const auth = request.headers.get('Authorization');
    if (!auth?.startsWith('Bearer mock-token-')) {
      return null;
    }
    return auth.slice('Bearer mock-token-'.length);
  }

  /**
   * The reporter identity behind a mock bearer, or `null` when there is no session.
   *
   * Two things are worth being explicit about here.
   *
   * First, this is deliberately not `roleFromToken`. Idempotency is scoped to a
   * *reporter*, and "which citizen is this" is not answerable with a role: two
   * signed-in citizens share `CITIZEN`, so scoping a replay on the role would let
   * one citizen's retry return another citizen's report - a cross-tenant read
   * created by a cache. So the role is reverse-mapped to the account that holds
   * it.
   *
   * Second, that reverse mapping is a limitation of the *mock*, not of the
   * contract. The mock issues `mock-token-<role>` from `POST /auth/login`, so its
   * bearer simply does not carry a user id, and there happens to be exactly one
   * account per role for the lookup to resolve. The contract says the real
   * identity is the user id, and a real backend that issued a role-only bearer
   * would make this whole rule unenforceable - two citizens would share one
   * identity and could read each other's replays. So the mock gets away with it and
   * a real one must not; if this ever needs to model two citizens at once, the
   * login response has to start carrying an id.
   */
  function signedInUserIdFrom(request: Request): string | null {
    const role = roleFromToken(request);
    if (role === null) {
      return null;
    }
    return Object.keys(ACCOUNTS).find((key) => ACCOUNTS[key]!.role === role) ?? null;
  }

/**
 * The `minLength` / `maxLength` / range constraints `IssueCreateForm` declares.
 *
 * Copied from the contract by hand rather than derived from it, which is a
 * duplication the generated types cannot express - `minLength` survives into the
 * OpenAPI document and into the Zod-free type only as prose. That is exactly why
 * this table is worth having: without it the mock accepts a three-character title
 * that the real server rejects with a 400, so a reporter loses a carefully typed
 * report at the moment of submitting it, having been told it worked.
 *
 * Declared once, next to the parser that produces the values, and asserted in
 * `handlers.spec.ts` by a test that reads these numbers rather than restating
 * them - so a contract change that moves a bound is a failing test rather than a
 * silent divergence.
 */
export const ISSUE_LIMITS = {
  title: { minLength: 5, maxLength: 200 },
  description: { minLength: 10, maxLength: 5000 },
  proposedCategoryText: { minLength: 3, maxLength: 100 },
  address: { maxLength: 300 },
  latitude: { min: -90, max: 90 },
  longitude: { min: -180, max: 180 },
  photos: { maxItems: 3 },
} as const;

/** Length violations, as contract `FieldError`s. Absent fields are not length errors. */
function lengthErrors(body: Partial<IssueCreateForm>): NonNullable<ErrorEnvelope['details']> {
  const errors: NonNullable<ErrorEnvelope['details']> = [];

  for (const field of ['title', 'description', 'proposedCategoryText', 'address'] as const) {
    const value = body[field];
    if (typeof value !== 'string') {
      continue;
    }
    const limits = ISSUE_LIMITS[field];
    // `address` carries only a `maxLength`, so `minLength` is read through an `in`
    // check rather than destructured - a form field that is optional has no lower
    // bound, and that absence is meaningful rather than a missing default.
    const minLength = 'minLength' in limits ? limits.minLength : undefined;
    const { maxLength } = limits;
    if (minLength !== undefined && value.length < minLength) {
      errors.push({ field, issue: `Must be at least ${minLength} characters.` });
    }
    if (value.length > maxLength) {
      errors.push({ field, issue: `Must be at most ${maxLength} characters.` });
    }
  }

  return errors;
}

/** Coordinate ranges. Out of range is a real coordinate error, not a null island. */
function rangeErrors(body: Partial<IssueCreateForm>): NonNullable<ErrorEnvelope['details']> {
  const errors: NonNullable<ErrorEnvelope['details']> = [];

  for (const field of ['latitude', 'longitude'] as const) {
    const value = body[field];
    if (typeof value !== 'number') {
      continue;
    }
    const { min, max } = ISSUE_LIMITS[field];
    if (value < min || value > max) {
      errors.push({ field, issue: `Must be between ${min} and ${max}.` });
    }
  }

  const photos = body.photos?.length ?? 0;
  if (photos > ISSUE_LIMITS.photos.maxItems) {
    errors.push({ field: 'photos', issue: `At most ${ISSUE_LIMITS.photos.maxItems} photos.` });
  }

  return errors;
}

/** The `/auth/**` rule: a bearer is a defect here, so it fails loudly. */
function rejectUnexpectedBearer(request: Request): HttpResponse<ErrorEnvelope> | null {
  if (request.headers.has('Authorization')) {
    return HttpResponse.json(
      envelope(
        401,
        'UNAUTHENTICATED',
        'This endpoint does not accept an Authorization header.',
        new URL(request.url).pathname,
      ),
      { status: 401 },
    );
  }
  return null;
}

export const handlers = [
  // --- auth -------------------------------------------------------------------------------------

  http.post(`${API}/auth/login`, async ({ request }) => {
    const path = new URL(request.url).pathname;
    const unexpected = rejectUnexpectedBearer(request);
    if (unexpected) {
      return unexpected;
    }

    const body = (await request.json()) as { email?: string; password?: string; clientType?: string };
    const user = body.email ? ACCOUNTS[body.email.toLowerCase()] : undefined;

    if (!user || body.password !== MOCK_PASSWORD) {
      return HttpResponse.json(
        envelope(401, 'UNAUTHENTICATED', 'Email or password is incorrect.', path),
        { status: 401 },
      );
    }

    return HttpResponse.json({
      accessToken: `mock-token-${user.role}`,
      // The contract sets the WEB refresh token as an HttpOnly cookie and leaves
      // this null; a mock that returned it here would teach the UI to read a
      // refresh token out of a response body, which the WEB client must never do.
      refreshToken: null,
      expiresIn: 900,
      clientType: body.clientType ?? 'WEB',
      user,
    });
  }),

  http.post(`${API}/auth/refresh`, ({ request }) => {
    const path = new URL(request.url).pathname;
    const unexpected = rejectUnexpectedBearer(request);
    if (unexpected) {
      return unexpected;
    }
    // Real: the HttpOnly cookie. Mock: a cookie the request must actually carry,
    // so the interceptor's `credentials: 'include'` is genuinely required.
    if (!request.headers.get('Cookie')?.includes('civiclens_refresh=')) {
      return unauthenticated(path);
    }
    return HttpResponse.json({
      accessToken: 'mock-token-CITIZEN',
      refreshToken: null,
      expiresIn: 900,
      clientType: 'WEB',
      user: ACCOUNTS['reporter@example.org'],
    });
  }),

  http.post(`${API}/auth/logout`, () => new HttpResponse(null, { status: 204 })),

  http.get(`${API}/auth/me`, ({ request }) => {
    const path = new URL(request.url).pathname;
    const role = roleFromToken(request);
    if (!role) {
      return unauthenticated(path);
    }
    const user = Object.values(ACCOUNTS).find((candidate) => candidate.role === role);
    return user ? HttpResponse.json(user) : unauthenticated(path);
  }),

  // --- issues -----------------------------------------------------------------------------------

  http.post(`${API}/issues`, async ({ request }) => {
    const path = new URL(request.url).pathname;

    // `Idempotency-Key` is `required: true` in the contract and typed `format:
    // uuid`, so the generated client will not let a form omit it. The mock used
    // to ignore it beyond checking presence, which meant the one guarantee that
    // cannot be checked any other way went unexercised: the key has to be the
    // *same* on a retry for the server to replay the original 201 - including the
    // original tracking token - instead of creating a second report. A form that
    // minted a fresh key per attempt would pass every test here and duplicate a
    // citizen's report in production, which is precisely what the header exists to
    // prevent.
    const idempotencyKey = request.headers.get('Idempotency-Key');
    if (!idempotencyKey) {
      return HttpResponse.json(
        envelope(
          400,
          'VALIDATION_ERROR',
          'The Idempotency-Key header is required.',
          path,
          [{ field: 'Idempotency-Key', issue: 'Required header, a client-generated UUID.' }],
        ),
        { status: 400 },
      );
    }

    // Presence is not the same as being a UUID. A counter, a timestamp or an
    // all-zero placeholder is what a client sends when it has not understood the
    // header, and every one of those collides in production while looking fine in
    // a mock that only checks for a non-empty string.
    if (!isValidIdempotencyKey(idempotencyKey)) {
      return HttpResponse.json(
        envelope(
          400,
          'VALIDATION_ERROR',
          'The Idempotency-Key header must be a UUID.',
          path,
          [
            {
              field: 'Idempotency-Key',
              issue: 'Must be a client-generated UUID, at most 100 characters.',
            },
          ],
        ),
        { status: 400 },
      );
    }

    const signedInUserId = signedInUserIdFrom(request);
    const identity = reporterIdentity(request, signedInUserId);

    // The contract declares this endpoint `multipart/form-data`, because a report
    // carries up to three photos, and the generated client therefore sends
    // `FormData`. This used to call `request.json()`, which throws on a multipart
    // body - so the mock rejected the one request it was supposed to model, and
    // the create-issue path had never actually been exercised against it.
    //
    // Every field arrives as a string, including the two numbers the contract
    // types as `number`. `formData` below is the single place that conversion
    // happens, so there is one parser to audit rather than one per handler.
    const form = await request.formData();
    const body = parseIssueCreateForm(form);

    // The replay check sits *after* parsing, because deciding whether a payload
    // is "materially different" needs the parsed body - and it sits *before*
    // validation, because a retry of a submission that already succeeded must not
    // be re-validated into a 400. The reporter already has their report; failing
    // their retry would be a way worse outcome than the duplicate the header
    // prevents.
    //
    // Only successful submissions are recorded, so a 400 above is never cached: a
    // citizen who fixed a validation error and retried with the same key gets a
    // fresh evaluation, not a replayed rejection.
    const fingerprint = fingerprintIssueCreate(body);
    const previous = idempotencyStore.lookup(identity, idempotencyKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        // Contract rule 4, and deliberately not a 409. The original report is
        // returned unchanged and nothing is created, so a client bug surfaces in
        // the log instead of as a citizen discovering that the report they
        // believed they filed never existed.
        recordIdempotencyMismatch(identity, idempotencyKey);
      }
      return HttpResponse.json(previous.response, { status: 201 });
    }

    // SPEC 3.2, enforced here as well as in the UI: `disclosure` is required with
    // no default, and a concealed report needs a contact channel and the
    // explicit consent marker.
    if (body.disclosure !== 'SHARE_DETAILS' && body.disclosure !== 'CONCEALED') {
      return HttpResponse.json(
        envelope(400, 'VALIDATION_ERROR', 'A disclosure choice is required.', path, [
          { field: 'disclosure', issue: 'Must be SHARE_DETAILS or CONCEALED.' },
        ]),
        { status: 400 },
      );
    }

    if (body.disclosure === 'CONCEALED') {
      const missing = [
        body.reporterContact ? null : 'reporterContact',
        body.contactDisclosureNote === '1' ? null : 'contactDisclosureNote',
      ].filter(Boolean);
      if (missing.length > 0) {
        return HttpResponse.json(
          envelope(400, 'VALIDATION_ERROR', 'A concealed report needs a contact channel.', path, [
            { field: missing[0]!, issue: 'Required when disclosure is CONCEALED.' },
          ]),
          { status: 400 },
        );
      }
    }

    // The contract types these four as present-and-typed rather than optional, so
    // a body missing any of them is one the real server rejects. Modelling that
    // here is what stops the mock from teaching a form to submit a report the
    // backend will refuse. `latitude`/`longitude` are the ones that matter most:
    // a client that dropped them on the floor would look fine against a mock
    // that only checks the disclosure rules.
    const invalid: ErrorEnvelope['details'] = [
      body.title ? null : { field: 'title', issue: 'Must not be blank.' },
      body.description ? null : { field: 'description', issue: 'Must not be blank.' },
      typeof body.latitude === 'number' ? null : { field: 'latitude', issue: 'Required.' },
      typeof body.longitude === 'number' ? null : { field: 'longitude', issue: 'Required.' },
    ].filter((entry): entry is { field: string; issue: string } => entry !== null);

    // `proposedCategoryText` is the citizen's own wording for a problem the
    // taxonomy does not cover. Required against the `OTHER` category and rejected
    // against any other, because it is stored as a proposal that a manager maps
    // onto the taxonomy at triage - a proposal attached to a category that already
    // fits is a duplicate waiting to happen.
    const isOtherCategory = CATEGORIES.find((c) => c.id === body.categoryId)?.code === 'OTHER';
    if (isOtherCategory && !body.proposedCategoryText) {
      invalid.push({
        field: 'proposedCategoryText',
        issue: 'Required when the category is OTHER.',
      });
    }
    if (!isOtherCategory && body.proposedCategoryText) {
      invalid.push({
        field: 'proposedCategoryText',
        issue: 'Rejected unless the category is OTHER.',
      });
    }

    if (invalid.length > 0) {
      return HttpResponse.json(
        envelope(400, 'VALIDATION_ERROR', 'The report is missing required fields.', path, invalid),
        { status: 400 },
      );
    }

    // The field-level constraints above decide only *whether* a field is present.
    // These decide whether its value is acceptable, and they are checked after
    // presence so that a missing field produces one error rather than two - a
    // reporter fixing a form wants "this is missing", not "this is missing and
    // also too short".
    const unacceptable = [...lengthErrors(body), ...rangeErrors(body)];
    if (unacceptable.length > 0) {
      return HttpResponse.json(
        envelope(400, 'VALIDATION_ERROR', 'One or more fields are not valid.', path, unacceptable),
        { status: 400 },
      );
    }

    // A contact channel on a shared report is the mirror of the rule above, and
    // it matters for the same reason: the address has to end up *not stored*, and
    // the only reliable way to achieve that is to refuse to accept it.
    if (body.disclosure === 'SHARE_DETAILS' && (body.reporterContact || body.contactDisclosureNote)) {
      return HttpResponse.json(
        envelope(400, 'VALIDATION_ERROR', 'A shared report must not carry a contact channel.', path, [
          {
            field: body.reporterContact ? 'reporterContact' : 'contactDisclosureNote',
            issue: 'Rejected when disclosure is SHARE_DETAILS.',
          },
        ]),
        { status: 400 },
      );
    }

    const category = CATEGORIES.find((c) => c.id === body.categoryId);
    const issue = createdIssue({
      // The four fields above are the ones validated as present, so these
      // narrowings are the assertion that they are: if one stops being checked,
      // this stops compiling rather than sending `undefined` to a `string`.
      title: body.title!,
      description: body.description!,
      disclosure: body.disclosure,
      categoryName: category?.name ?? null,
      proposedCategoryText: body.proposedCategoryText ?? null,
      latitude: body.latitude!,
      longitude: body.longitude!,
      address: body.address ?? null,
    });

    // SPEC 7.1: the contact address is never echoed back, to anyone. A mock that
    // returned it would let a UI get comfortable displaying it.
    //
    // The two conditional fields are the reason this handler is worth reading.
    // `trackingToken` is returned exactly once in the life of a concealed report
    // and is unrecoverable afterwards, so the client has to persist it before it
    // navigates anywhere - and this mock is where a UI would be judged to handle
    // that. `contactVerificationRequired` is what stops it navigating to a status
    // page that cannot resolve, because a concealed report sits unverified and
    // out of every queue until the reporter proves they own the address.
    //
    // The contract is explicit that the token is "present only for a concealed
    // submission. Absent (null) for a signed-in citizen, whose access comes from
    // their session instead." A signed-in reporter therefore gets `null` even
    // when they choose CONCEALED - their concealment is enforced by the fact that
    // staff cannot see their identity, not by withholding their own account. This
    // is the one place a *signed-in* request changes the response, and it is
    // invisible in dev unless the request is checked, so it is checked here.
    const signedIn = signedInUserIdFrom(request) !== null;
    const trackingToken = body.disclosure === 'CONCEALED' && !signedIn ? deriveTrackingToken(identity) : null;
    if (trackingToken) {
      // The token has to open something, or the mock models a system where filing
      // a concealed report as a citizen costs you access to it.
      registerTrackedReport(trackingToken, issue);
    }

    const response: IssueCreateResponse = {
      issue,
      contactVerificationRequired: body.disclosure === 'CONCEALED',
      trackingToken,
      publicShareUrl: `${PUBLIC_ORIGIN}/public/${issue.publicCode}`,
    };

    // Recorded only now, once every rule above has passed, so the cache holds
    // successful submissions and nothing else. `identity` is part of the key
    // because "the same reporter" is what the contract scopes a replay to.
    idempotencyStore.remember(identity, idempotencyKey, fingerprint, response);

    return HttpResponse.json(response, { status: 201 });
  }),

  http.get(`${API}/issues`, ({ request }) => {
    const path = new URL(request.url).pathname;
    const role = roleFromToken(request);
    if (!role) {
      return unauthenticated(path);
    }
    if (role === 'CITIZEN') {
      return forbidden(path, 'Use GET /issues/mine for your own reports.');
    }
    return HttpResponse.json(issuePage(ISSUES));
  }),

  http.get(`${API}/issues/mine`, ({ request }) => {
    const path = new URL(request.url).pathname;
    // A citizen's own reports, or a concealed reporter's via the tracked tree.
    // This endpoint answers to a session only.
    if (!roleFromToken(request)) {
      return unauthenticated(path);
    }
    return HttpResponse.json(issuePage([ISSUES[0]!]));
  }),

  http.get(`${API}/issues/:issueId`, ({ request, params }) => {
    const path = new URL(request.url).pathname;
    const role = roleFromToken(request);
    if (!role) {
      return unauthenticated(path);
    }
    if (role === 'CITIZEN') {
      return forbidden(path, 'A concealed report is only reachable through /tracked.');
    }
    const issue = ISSUES.find((candidate) => candidate.id === params['issueId']);
    return issue ? HttpResponse.json(issue) : notFound(path);
  }),

  // --- tracked (token credential) ---------------------------------------------------------------

  http.get(`${API}/tracked/issues`, ({ request }) => {
    const path = new URL(request.url).pathname;
    if (rejectUnexpectedBearer(request)) {
      return forbidden(path, '/tracked/** is authenticated by the tracking token, not a session.');
    }
    const token = request.headers.get('X-Tracking-Token');
    const reports = token ? trackedSummariesFor(token) : null;
    if (!reports) {
      return forbidden(path, 'A valid tracking token is required.');
    }
    // A list, because one token is a device and a device accumulates reports. This
    // endpoint returned a single hard-coded report for a single hard-coded token,
    // which meant a token handed out by `POST /issues` reached nothing.
    return HttpResponse.json(issuePage(reports));
  }),

  http.get(`${API}/tracked/issues/:issueId`, ({ request, params }) => {
    const path = new URL(request.url).pathname;
    if (rejectUnexpectedBearer(request)) {
      return forbidden(path, '/tracked/** is authenticated by the tracking token, not a session.');
    }
    const token = request.headers.get('X-Tracking-Token');
    const requestedId = params['issueId'];
    const issueId = typeof requestedId === 'string' ? requestedId : undefined;
    const issue = token && issueId ? trackedDetailFor(token, issueId) : undefined;
    if (!issue) {
      // A token the mock never issued and an id that is not under it are both
      // "not found" rather than "forbidden", so this endpoint does not confirm
      // that an id exists to a caller holding the wrong token.
      return token && trackedSummariesFor(token)
        ? notFound(path)
        : forbidden(path, 'A valid tracking token is required.');
    }
    return HttpResponse.json(issue);
  }),

  // --- public and reference (no credential) ----------------------------------------------------

  http.get(`${API}/public/issues/:publicCode`, ({ request, params }) => {
    const path = new URL(request.url).pathname;
    if (rejectUnexpectedBearer(request)) {
      return HttpResponse.json(
        envelope(400, 'VALIDATION_ERROR', 'This endpoint does not accept an Authorization header.', path),
        { status: 400 },
      );
    }
    if (params['publicCode'] !== PUBLIC_ISSUE.publicCode) {
      return notFound(path);
    }
    return HttpResponse.json(PUBLIC_ISSUE);
  }),

  // `/reference/**` is the opposite case to `/public/**`, and the difference is
  // easy to get wrong. The contract does *not* mark these operations
  // `security: []`, so they inherit the global bearer and a signed-in caller is
  // expected to send one. An earlier draft of this file rejected a bearer here
  // "to be safe", which 403'd every legitimate request - a mock that disagrees
  // with the contract is worse than no mock, because it teaches the UI to work
  // around a rule that does not exist.
  http.get(`${API}/reference/categories`, () => HttpResponse.json(CATEGORIES)),

  http.get(`${API}/reference/departments`, () =>
    HttpResponse.json([
      { id: 'dept-roads', name: 'Roads and Highways', active: true },
      { id: 'dept-parks', name: 'Parks and Open Spaces', active: true },
    ]),
  ),

  // --- notifications -----------------------------------------------------------------------------

  http.get(`${API}/notifications`, ({ request }) => {
    const path = new URL(request.url).pathname;
    const role = roleFromToken(request);
    if (!role) {
      return unauthenticated(path);
    }
    if (role === 'CITIZEN') {
      // SPEC 3.2: a concealed reporter has no account, so `/notifications` is
      // not where they hear about their report. Rejecting this is what stops a
      // future screen from quietly treating it as the concealed update channel.
      return forbidden(path, 'Concealed reporters are notified by email, not here.');
    }
    return HttpResponse.json(notificationPage(NOTIFICATIONS));
  }),

  http.post(`${API}/notifications/read-all`, ({ request }) => {
    const path = new URL(request.url).pathname;
    if (!roleFromToken(request)) {
      return unauthenticated(path);
    }
    return new HttpResponse(null, { status: 204 });
  }),

  // --- dashboard ----------------------------------------------------------------------------------

  http.get(`${API}/dashboard`, ({ request }) => {
    const path = new URL(request.url).pathname;
    const role = roleFromToken(request);
    if (!role) {
      return unauthenticated(path);
    }
    if (role !== 'DEPARTMENT_MANAGER' && role !== 'ADMIN') {
      return forbidden(path, 'The dashboard is for managers and admins.');
    }
    return HttpResponse.json({
      openIssues: 128,
      resolvedThisMonth: 46,
      breachesOpen: 3,
      awaitingConfirmation: 7,
      byStatus: {
        SUBMITTED: 4,
        AI_ANALYZING: 18,
        TRIAGED: 9,
        ASSIGNED: 12,
        IN_PROGRESS: 41,
        RESOLVED: 37,
        CLOSED: 214,
        REOPENED: 2,
        REJECTED: 5,
        DUPLICATE: 11,
        CANCELLED: 1,
      },
    });
  }),
];
