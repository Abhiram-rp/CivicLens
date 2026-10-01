import { HttpResponse } from 'msw';
import type { IssueCreateForm, IssueCreateResponse, ReporterContact } from '../../app/api/generated/types.gen';
import {
  NOW,
  appendAudit,
  envelope,
  nextIdForIssue,
  state,
  type StoredCategory,
  type StoredIssue,
} from '../store';
import {
  deriveTrackingToken,
  fingerprintIssueCreate,
  idempotencyStore,
  isValidIdempotencyKey,
  recordIdempotencyMismatch,
  reporterIdentity,
} from '../idempotency';
import { registerTrackedReport, setContactEmail } from '../tracking';
import { asStaffDetail } from '../projections';
import { STATUS_LABELS } from '../state-machine';
import type { Caller } from '../http';

/**
 * `POST /issues`: multipart validation, idempotent replay, and the one place a
 * tracking token is minted.
 *
 * Extracted from the handler array because it is the single most consequential
 * endpoint in the product and the one with the most rules. Every one of them is a
 * rule a citizen can lose a report to:
 *
 *   - the `Idempotency-Key` must be present *and* be a UUID, or a retry creates a
 *     second report;
 *   - a replay returns the original 201 including the original token, before any
 *     re-validation, because the reporter already has their report;
 *   - a materially different payload on the same key returns the original report
 *     and logs, never a 409;
 *   - a concealed report needs a contact channel and the explicit consent marker;
 *   - the contact address is never echoed, and the token is returned exactly once.
 */

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
 * Typed as the contract's `IssueCreateForm` so it cannot drift from it. It returns
 * a *partial*: a body the client got wrong is not an error this parser should
 * raise, because the 400 that comes back has to be the contract's error envelope
 * with per-field detail, and that is decided below.
 *
 * `latitude`/`longitude` are the two fields typed as `number` that multipart
 * delivers as text. `Number('')` is `0`, which is a real coordinate in the Gulf of
 * Guinea, so the empty case is reported as absent rather than silently becoming
 * null island.
 */
export function parseIssueCreateForm(form: FormData): Partial<IssueCreateForm> {
  const contactType = text(form.get('reporterContact.type'));
  const contactValue = text(form.get('reporterContact.value'));
  // `ContactChannelType` is the single-member union `'EMAIL'`, so the form value is
  // narrowed against it rather than cast. An unrecognised channel is dropped here,
  // which surfaces as the contract's "contact channel required" 400 rather than a
  // mock-only complaint - the real server has exactly one channel type, so
  // agreeing with it is what makes the mock a useful rehearsal.
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
    // client that sent `'yes'` does not satisfy a check the contract describes as a
    // constant marker.
    contactDisclosureNote: note === '1' ? '1' : undefined,
    categoryId: text(form.get('categoryId')),
    subcategoryId: text(form.get('subcategoryId')),
    proposedCategoryText: text(form.get('proposedCategoryText')),
    latitude: coordinate('latitude'),
    longitude: coordinate('longitude'),
    address: text(form.get('address')),
    // A repeated field, so `get` would only ever see the first one.
    photos: form.getAll('photos').filter((entry): entry is File => entry instanceof File),
  };
}

/**
 * The `minLength`/`maxLength`/range constraints `IssueCreateForm` declares.
 *
 * Copied from the contract by hand, because those bounds survive into the generated
 * types only as prose. The point of checking them is that a mock which accepts a
 * three-character title lets a reporter submit something the real server rejects -
 * losing a carefully typed report at the moment of submitting it, having been told
 * it worked.
 *
 * Declared once here and asserted in `handlers.spec.ts` by a test that reads these
 * numbers rather than restating them, so a contract change that moves a bound is a
 * failing test rather than a silent divergence.
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

/** The origin used to build `publicShareUrl`. */
const PUBLIC_ORIGIN = 'https://civiclens.example.org';

/**
 * The upload media types the contract accepts.
 *
 * These four and nothing else. The gap this closes is subtle: a mock that checks
 * only "at most 3 photos" accepts a 4 MB PDF renamed to `.jpg`, so a reporter's
 * submission looks fine all the way to production and then fails at the one moment
 * they cannot retry from the form - having already been told it worked.
 */
const ACCEPTED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;

export async function createIssueReport(input: {
  request: Request;
  form: FormData;
  caller: Caller;
  path: string;
}): Promise<Response> {
  const { request, form, caller, path } = input;

  // `Idempotency-Key` is `required: true` in the contract and typed `format: uuid`.
  const idempotencyKey = request.headers.get('Idempotency-Key');
  if (!idempotencyKey) {
    return HttpResponse.json(
      envelope(400, 'VALIDATION_ERROR', 'The Idempotency-Key header is required.', path, [
        { field: 'Idempotency-Key', issue: 'Required header, a client-generated UUID.' },
      ]),
      { status: 400 },
    );
  }

  // Presence is not the same as being a UUID. A counter, a timestamp or an
  // all-zero placeholder is what a client sends when it has not understood the
  // header, and every one of those collides in production while looking fine in a
  // mock that only checks for a non-empty string.
  if (!isValidIdempotencyKey(idempotencyKey)) {
    return HttpResponse.json(
      envelope(400, 'VALIDATION_ERROR', 'The Idempotency-Key header must be a UUID.', path, [
        { field: 'Idempotency-Key', issue: 'Must be a client-generated UUID, at most 100 characters.' },
      ]),
      { status: 400 },
    );
  }

  const identity = reporterIdentity(request, caller.userId);
  const body = parseIssueCreateForm(form);

  // The replay check sits *after* parsing - deciding whether a payload is
  // "materially different" needs the parsed body - and *before* validation, because
  // a retry of a submission that already succeeded must not be re-validated into a
  // 400. The reporter already has their report; failing their retry would be a far
  // worse outcome than the duplicate the header prevents.
  //
  // Only successful submissions are recorded, so a 400 below is never cached: a
  // citizen who fixed a validation error and retried with the same key gets a fresh
  // evaluation, not a replayed rejection.
  const fingerprint = fingerprintIssueCreate(body);
  const previous = idempotencyStore.lookup(identity, idempotencyKey);
  if (previous) {
    if (previous.fingerprint !== fingerprint) {
      // Contract rule 4, and deliberately not a 409. The original report is
      // returned unchanged and nothing is created, so a client bug surfaces in the
      // log instead of as a citizen discovering that the report they believed they
      // filed never existed.
      recordIdempotencyMismatch(identity, idempotencyKey);
    }
    return HttpResponse.json(previous.response, { status: 201 });
  }

  // SPEC 3.2, enforced here as well as in the UI: `disclosure` is required with no
  // default, because a preselected "share my details" is a consent the reporter
  // never gave.
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

  // The contract types these as present-and-typed rather than optional, so a body
  // missing any is one the real server rejects. `latitude`/`longitude` matter most:
  // a client that dropped them would look fine against a mock that only checked the
  // disclosure rules.
  const invalid: { field: string; issue: string }[] = [
    body.title ? null : { field: 'title', issue: 'Must not be blank.' },
    body.description ? null : { field: 'description', issue: 'Must not be blank.' },
    typeof body.latitude === 'number' ? null : { field: 'latitude', issue: 'Required.' },
    typeof body.longitude === 'number' ? null : { field: 'longitude', issue: 'Required.' },
  ].filter((entry): entry is { field: string; issue: string } => entry !== null);

  // `proposedCategoryText` is the citizen's own wording for a problem the taxonomy
  // does not cover. Required against `OTHER` and rejected against any other, because
  // it is stored as a proposal a manager maps onto the taxonomy at triage, and a
  // proposal on a category that already fits is a duplicate waiting to happen.
  const category = state.categories.find((candidate) => candidate.id === body.categoryId);
  const isOtherCategory = category?.code === 'OTHER';
  if (isOtherCategory && !body.proposedCategoryText) {
    invalid.push({ field: 'proposedCategoryText', issue: 'Required when the category is OTHER.' });
  }
  if (!isOtherCategory && body.proposedCategoryText) {
    invalid.push({ field: 'proposedCategoryText', issue: 'Rejected unless the category is OTHER.' });
  }

  if (invalid.length > 0) {
    return HttpResponse.json(
      envelope(400, 'VALIDATION_ERROR', 'The report is missing required fields.', path, invalid),
      { status: 400 },
    );
  }

  // Presence first, then acceptability - so a missing field produces one error
  // rather than two. A reporter fixing a form wants "this is missing", not "this
  // is missing and also too short".
  const unacceptable = [...lengthErrors(body), ...rangeErrors(body)];
  if (unacceptable.length > 0) {
    return HttpResponse.json(
      envelope(400, 'VALIDATION_ERROR', 'One or more fields are not valid.', path, unacceptable),
      { status: 400 },
    );
  }

  // A contact channel on a shared report is the mirror of the rule above, and it
  // matters for the same reason: the address has to end up *not stored*, and the
  // only reliable way to achieve that is to refuse to accept it.
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

  const issue = storeCreatedIssue(body, category, caller);
  // Kept on the row so a replay is traceable back to the request that created it,
  // rather than only to a cache entry nobody can inspect from the store.
  issue.createKey = idempotencyKey;

  // SPEC 7.1: the contact address is never echoed back, to anyone. A mock that
  // returned it would let a UI get comfortable displaying it. Held on the store only
  // so `/contact/verify` can match a token to this channel.
  setContactEmail(issue, body.reporterContact);

  if (body.disclosure === 'CONCEALED') {
    // The verification link the reporter is emailed. Minted here rather than in the
    // seeder so a *newly created* concealed report is reachable through the real
    // flow, not only the seeded one - otherwise `contactVerificationRequired` would
    // be true on every create while only the fixture's report could ever leave
    // `PENDING_VERIFICATION`. Deterministic and derived from the public code so a
    // developer can read it out of a screenshot the way they would out of an inbox.
    state.verificationTokens.set(`mock-verify-${issue.publicCode}`, {
      issueId: issue.id,
      email: issue.contactEmail ?? '',
      expiresAt: new Date(Date.parse(NOW) + 7 * 86_400_000).toISOString(),
      used: false,
    });
  }

  // SPEC: the token is returned exactly once in the life of a concealed report and
  // is unrecoverable afterwards, so the client must persist it before navigating
  // anywhere. `contactVerificationRequired` is what stops it navigating to a status
  // page that cannot resolve, because a concealed report sits unverified and out of
  // every queue until the reporter proves they own the address.
  const signedIn = caller.userId !== null;
  const trackingToken = body.disclosure === 'CONCEALED' && !signedIn ? deriveTrackingToken(identity) : null;
  if (trackingToken) {
    // The token has to open something, or the mock models a system where filing a
    // concealed report costs you access to it.
    registerTrackedReport(trackingToken, issue);
  }

  const response: IssueCreateResponse = {
    // `IssueCreateResponse.issue` is `IssueDetail`, not the reporter's tracked
    // projection: the create response is the one document that reaches both a
    // signed-in reporter and an anonymous one, so it is the *staff* shape with the
    // concealed fields already null. Returning `TrackedIssueDetail` here would be
    // the more private choice and the wrong one - it drops the coordinates the
    // reporter just supplied, so the reporter could not see their own report the
    // way they filed it. Concealment is enforced by `reporterId: null` and
    // `reporterDisplayName: null`, not by withholding the reporter's own data.
    issue: asStaffDetail(issue, caller),
    contactVerificationRequired: body.disclosure === 'CONCEALED',
    // Null for a signed-in citizen, whose access comes from their session. Their
    // concealment is enforced by staff not seeing their identity, not by withholding
    // their own account.
    trackingToken,
    publicShareUrl: `${PUBLIC_ORIGIN}/public/${issue.publicCode}`,
  };

  // Recorded only now, once every rule above has passed, so the cache holds
  // successful submissions and nothing else. `identity` is part of the key because
  // "the same reporter" is what the contract scopes a replay to.
  idempotencyStore.remember(identity, idempotencyKey, fingerprint, response);

  appendAudit({
    actorId: caller.userId,
    actorName: caller.userId ? caller.displayName : null,
    action: 'ISSUE_CREATED',
    entityType: 'Issue',
    entityId: issue.id,
    newValue: { disclosure: issue.disclosure },
    // A concealed report's audit row records no IP: a reporter's IP is the only
    // identity such a report has.
    concealed: issue.disclosure === 'CONCEALED',
  });

  return HttpResponse.json(response, { status: 201 });
}

/** Build and register the report row. */
function storeCreatedIssue(
  body: Partial<IssueCreateForm>,
  category: StoredCategory | undefined,
  caller: Caller,
): StoredIssue {
  const { id, publicCode } = nextIdForIssue();
  const concealed = body.disclosure === 'CONCEALED';
  const now = NOW;
  const subcategory = category?.subcategories.find((candidate) => candidate.id === body.subcategoryId);
  const department = category?.defaultDepartmentId
    ? state.departments.find((candidate) => candidate.id === category.defaultDepartmentId)
    : undefined;

  const issue: StoredIssue = {
    id,
    publicCode,
    title: body.title!,
    description: body.description!,
    // A concealed report is not yet out of any queue, so it sits in a contact
    // *state* rather than advancing into triage. `PENDING_VERIFICATION` is a
    // `ContactState`, not an `IssueStatus` - the report's own status is SUBMITTED
    // and it never enters an officer's queue. Conflating the two produces a status
    // screen that can never resolve, which is what `contactVerificationRequired`
    // exists to stop. The label says "Received" in both cases, because that is the
    // only thing true of a report nobody has looked at yet.
    status: 'SUBMITTED',
    statusLabel: STATUS_LABELS['SUBMITTED'],
    priority: 'LOW',
    priorityScore: 20,
    priorityBreakdown: null,
    severity: 'LOW',
    categoryId: category?.id ?? null,
    categoryName: category?.name ?? null,
    subcategoryId: subcategory?.id ?? null,
    subcategoryName: subcategory?.name ?? null,
    proposedCategoryText: body.proposedCategoryText ?? null,
    disclosure: body.disclosure!,
    latitude: body.latitude!,
    longitude: body.longitude!,
    address: body.address ?? null,
    // `areaLabel` is the coarse, human-facing area. Realistically derived from a
    // reverse geocode, which a mock has no data for, so it carries the address the
    // reporter typed rather than a place name. Deliberately not the coordinates:
    // this field is what a public list may show, and a lat/lng pair in it would
    // quietly put an exact home location on a public page.
    areaLabel: body.address ?? null,
    // The reporter's account, and only when there is one to record: a signed-in
    // citizen who shared their details. Concealed is null *even for a signed-in
    // reporter* - the account exists, but the report must not point at it, because
    // a null reporter is what keeps the report out of "this citizen's reports"
    // joins. An anonymous report has no account to point at either.
    reporterId: concealed ? null : caller.userId,
    reporterDisplayName: null,
    assignedDepartmentId: department?.id ?? null,
    assignedDepartmentName: department?.name ?? null,
    assignedOfficerId: null,
    assignedOfficerName: null,
    confirmationCount: 0,
    // The count that was *accepted*, which is a weaker claim than it looks. SPEC
    // §13 has normalization and storage between acceptance and visibility, so a UI
    // must not read this as "an officer can see your photos". This mock has no
    // storage at all, so any stronger guarantee would be something the mock
    // invented and a real backend would not honour.
    photoCount: body.photos?.length ?? 0,
    aiUnavailable: false,
    aiSuggestions: [],
    attachments: [],
    statusHistory: [
      {
        id: `ste-${id}`,
        // Absent, not null: the contract types `fromStatus` as optional and has no
        // null for it, because "nothing preceded this" is the only row that has no
        // from-status and a null here would be a value no other row can take.
        fromStatus: undefined,
        toStatus: 'SUBMITTED',
        changedById: null,
        changedByName: 'CivicLens',
        reason: 'Report received.',
        createdAt: now,
      },
    ],
    sla: null,
    resolutionReport: null,
    contactState: concealed ? 'PENDING_VERIFICATION' : undefined,
    approvalDeadline: null,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    closedAt: null,
    reopenWindowEndsAt: null,
    awaitingConfirmation: false,
    contactEmail: null,
    revealRequested: false,
    createKey: null,
    now,
  };

  state.issues.push(issue);
  return issue;
}

/** Length violations, as contract `FieldError`s. Absent fields are not length errors. */
function lengthErrors(body: Partial<IssueCreateForm>): { field: string; issue: string }[] {
  const errors: { field: string; issue: string }[] = [];
  for (const field of ['title', 'description', 'proposedCategoryText', 'address'] as const) {
    const value = body[field];
    if (typeof value !== 'string') {
      continue;
    }
    const limits = ISSUE_LIMITS[field];
    // `address` carries only a `maxLength`, so `minLength` is read through an `in`
    // check rather than destructured - an optional field has no lower bound, and
    // that absence is meaningful rather than a missing default.
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

/** Coordinate ranges, the photo count, and the upload media types. */
function rangeErrors(body: Partial<IssueCreateForm>): { field: string; issue: string }[] {
  const errors: { field: string; issue: string }[] = [];
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

  const photos = body.photos ?? [];
  if (photos.length > ISSUE_LIMITS.photos.maxItems) {
    errors.push({ field: 'photos', issue: `At most ${ISSUE_LIMITS.photos.maxItems} photos.` });
  }

  // Checked per file rather than as one boolean, so the reporter is told *which*
  // attachment was rejected. An error that says only "photos are invalid" on a
  // three-photo form means they have to remove attachments one at a time to find
  // out which one the server disliked.
  photos.forEach((photo, index) => {
    if (!ACCEPTED_MEDIA_TYPES.includes(photo.type as (typeof ACCEPTED_MEDIA_TYPES)[number])) {
      errors.push({
        field: `photos[${index}]`,
        issue: `Must be one of: ${ACCEPTED_MEDIA_TYPES.join(', ')}.`,
      });
    }
  });

  return errors;
}
