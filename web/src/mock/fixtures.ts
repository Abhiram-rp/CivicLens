import type {
  Category,
  CurrentUser,
  Disclosure,
  IssueDetail,
  IssueSummary,
  IssueSummaryPage,
  Notification,
  NotificationPage,
  PublicIssue,
  TrackedIssueDetail,
} from '../app/api/generated/types.gen';

/**
 * Fixture data for the development mock server.
 *
 * Typed against the generated contract types rather than hand-written objects,
 * which is the point: if the contract changes a field these fixtures stop
 * compiling instead of quietly sending a shape the UI has never handled. An
 * earlier draft of this file used a `roles: Role[]` array, a `displayName` field
 * and `OFFICER`/`MANAGER` role names - all three wrong, and all three caught by
 * the compiler the moment this file was typed against the contract rather than
 * against a guess.
 *
 * Timestamps are fixed rather than relative to "now" so the same screenshot is
 * reproducible next month.
 */

const T0 = Date.parse('2026-03-02T09:15:00Z');

function at(days: number, hours = 0): string {
  return new Date(T0 + days * 86_400_000 + hours * 3_600_000).toISOString();
}

export const CITIZEN: CurrentUser = {
  id: 'usr-citizen-1',
  email: 'reporter@example.org',
  fullName: 'Sam Rivera',
  role: 'CITIZEN',
  departmentId: null,
  departmentName: null,
};

export const OFFICER: CurrentUser = {
  id: 'usr-officer-1',
  email: 'officer@civiclens.example.org',
  fullName: 'Priya Raman',
  role: 'FIELD_OFFICER',
  departmentId: 'dept-roads',
  departmentName: 'Roads and Highways',
};

export const MANAGER: CurrentUser = {
  id: 'usr-manager-1',
  email: 'manager@civiclens.example.org',
  fullName: 'Alex Doyle',
  role: 'DEPARTMENT_MANAGER',
  departmentId: 'dept-roads',
  departmentName: 'Roads and Highways',
};

export const ADMIN: CurrentUser = {
  id: 'usr-admin-1',
  email: 'admin@civiclens.example.org',
  fullName: 'Robin Vale',
  role: 'ADMIN',
  departmentId: null,
  departmentName: null,
};

export const CATEGORIES: Category[] = [
  {
    id: 'cat-roads',
    name: 'Roads and pavements',
    code: 'ROADS',
    active: true,
    defaultDepartmentId: 'dept-roads',
    subcategories: [
      { id: 'cat-roads-pothole', name: 'Pothole', code: 'ROADS_POTHOLE', active: true },
      { id: 'cat-roads-paving', name: 'Paving and kerbs', code: 'ROADS_PAVING', active: true },
    ],
  },
  {
    id: 'cat-lighting',
    name: 'Street lighting',
    code: 'LIGHTING',
    active: true,
    defaultDepartmentId: 'dept-roads',
    subcategories: [
      { id: 'cat-lighting-out', name: 'Light not working', code: 'LIGHTING_OUT', active: true },
    ],
  },
  {
    id: 'cat-other',
    name: 'Something else',
    code: 'OTHER',
    active: true,
    defaultDepartmentId: null,
    subcategories: [],
  },
];

/**
 * Two reports, deliberately different in the one dimension that matters.
 *
 * `iss-shared-1` is shared, `iss-concealed-1` is concealed. Any mock that
 * renders a reporter identity on the concealed one is a bug, and having both on
 * screen at once is what makes that bug visible rather than theoretical.
 */
export const ISSUES: IssueSummary[] = [
  {
    id: 'iss-shared-1',
    publicCode: 'CL-2026-0001',
    title: 'Pothole outside 14 Elm Road',
    status: 'IN_PROGRESS',
    statusLabel: 'Work scheduled',
    priority: 'MEDIUM',
    categoryName: 'Roads and pavements',
    areaLabel: 'Elm Road',
    confirmationCount: 6,
    photoCount: 2,
    assignedDepartmentName: 'Roads and Highways',
    disclosure: 'SHARE_DETAILS',
    // `contactState` is `ContactState | undefined`, not nullable: a shared report
    // has no contact channel to be in a state, so the field is absent rather
    // than null. The contract distinguishes "not applicable" from "unknown",
    // which is a distinction worth preserving in a mock.
    approvalDeadline: null,
    createdAt: at(-6),
    updatedAt: at(-2),
  },
  {
    id: 'iss-concealed-1',
    publicCode: 'CL-2026-0002',
    title: 'Street light out on the estate road',
    status: 'AI_ANALYZING',
    statusLabel: 'Under review',
    priority: 'LOW',
    categoryName: 'Street lighting',
    areaLabel: 'Hawthorn Estate',
    confirmationCount: 1,
    photoCount: 0,
    assignedDepartmentName: 'Roads and Highways',
    disclosure: 'CONCEALED',
    contactState: 'PENDING_VERIFICATION',
    approvalDeadline: null,
    createdAt: at(-1),
    updatedAt: at(-1),
  },
];

/**
 * The concealed report, as its own reporter sees it.
 *
 * Note what is absent: there is no reporter, no reporter name, and no
 * `reporterContact` echo. SPEC 7.1 does not return the contact address in any
 * response - not even to the reporter who supplied it - because a response that
 * returns it is a response that ends up in a log.
 */
export const TRACKED_ISSUE: TrackedIssueDetail = {
  id: 'iss-concealed-1',
  publicCode: 'CL-2026-0002',
  title: 'Street light out on the estate road',
  description:
    'The street light outside the play area has been out for about a week. It is very dark when I walk the dog in the evening.',
  status: 'AI_ANALYZING',
  statusLabel: 'Under review',
  disclosure: 'CONCEALED',
  priority: 'LOW',
  categoryName: 'Street lighting',
  areaLabel: 'Hawthorn Estate',
  assignedDepartmentName: 'Roads and Highways',
  contactState: 'PENDING_VERIFICATION',
  approvalDeadline: null,
  confirmationCount: 1,
  photoCount: 0,
  statusHistory: [
    {
      id: 'ste-1',
      // `fromStatus` is `IssueStatus | undefined`, not nullable. The first
      // transition has no previous status, and the contract says "absent", not
      // "null" - so the key is simply not set.
      toStatus: 'SUBMITTED',
      changedByName: 'CivicLens',
      reason: 'Report received.',
      createdAt: at(-1),
    },
    {
      id: 'ste-2',
      fromStatus: 'SUBMITTED',
      toStatus: 'AI_ANALYZING',
      changedByName: 'CivicLens',
      reason: 'Being reviewed.',
      createdAt: at(-1, -1),
    },
  ],
  createdAt: at(-1),
  updatedAt: at(-1),
};

/**
 * The same report as anyone may see it. No reporter field exists on this type at
 * all, which is the contract enforcing concealment structurally rather than by
 * asking the server to remember to omit a field.
 */
export const PUBLIC_ISSUE: PublicIssue = {
  publicCode: 'CL-2026-0002',
  title: 'Street light out on the estate road',
  titleRedacted: false,
  categoryName: 'Street lighting',
  status: 'AI_ANALYZING',
  statusLabel: 'Under review',
  priority: 'LOW',
  confirmationCount: 1,
  photoCount: 0,
  areaLabel: 'Hawthorn Estate',
  submittedAt: at(-1),
  resolvedAt: null,
  closedAt: null,
};

export const NOTIFICATIONS: Notification[] = [
  {
    id: 'ntf-1',
    type: 'ISSUE_RESOLVED',
    channel: 'IN_APP',
    title: 'A fix has been proposed for your report',
    body: 'Roads and Highways marked the street light on the Hawthorn Estate as repaired. You have seven days to confirm it.',
    read: false,
    payload: { issueId: 'iss-concealed-1' },
    createdAt: at(-1, 2),
  },
  {
    id: 'ntf-2',
    type: 'ISSUE_ASSIGNED',
    channel: 'IN_APP',
    title: 'Your report has been assigned',
    body: 'Roads and Highways are now looking at your report.',
    read: true,
    payload: { issueId: 'iss-concealed-1' },
    createdAt: at(-1),
  },
];

export function issuePage(content: IssueSummary[], page = 0, size = 20): IssueSummaryPage {
  return {
    content,
    page,
    size,
    totalElements: content.length,
    totalPages: 1,
    hasNext: false,
  };
}

export function notificationPage(content: Notification[]): NotificationPage {
  return {
    content,
    page: 0,
    size: content.length,
    totalElements: content.length,
    totalPages: 1,
    hasNext: false,
  };
}

/**
 * The accounts `login` accepts, keyed by the email in the fixture set. The role
 * names are the contract's own, so signing in as each one produces a session
 * that passes the same guards as a real one.
 */
export const ACCOUNTS: Record<string, CurrentUser> = {
  'reporter@example.org': CITIZEN,
  'officer@civiclens.example.org': OFFICER,
  'manager@civiclens.example.org': MANAGER,
  'admin@civiclens.example.org': ADMIN,
};

/**
 * The password every mock account accepts.
 *
 * Written to be unmistakably a placeholder rather than password-shaped. The
 * repository's `.gitignore` notes a plan to add gitleaks to CI, and a fixture
 * whose *name* says PASSWORD and whose value looks random is exactly the kind of
 * thing a secret scanner flags - in a file where it is a deliberate non-secret.
 * Spelling it out costs nothing now and saves a false positive later.
 */
export const MOCK_PASSWORD = 'mock-password-do-not-use';

/** The tracking token the mock server will accept on `/tracked/**`. */
export const MOCK_TRACKING_TOKEN = 'civiclens-mock-tracking-token-do-not-use';

/**
 * A walk of `publicCode` for reports created through `POST /issues`.
 *
 * `public_code` is documented as a dense walkable range and is what a share link
 * is built from, so two reports must never share one. The builder used to return
 * the same `id` and `publicCode` for every call, which made a duplicate invisible:
 * a client that filed the same report twice got back two responses with the same
 * share URL, and nothing anywhere could tell the difference. That is the same
 * class of bug as the idempotency cache being absent, one layer down.
 *
 * Starts past the seeded fixtures so a created report cannot collide with one the
 * mock ships with.
 */
let createdReportSequence = 2;

function nextCreatedReportIds(): { id: string; publicCode: string } {
  createdReportSequence += 1;
  const n = String(createdReportSequence).padStart(4, '0');
  return { id: `iss-mock-new-${n}`, publicCode: `CL-2026-${n}` };
}

/** Reset the created-report walk, so each test starts from the same state. */
export function resetCreatedReportSequence(): void {
  createdReportSequence = 2;
}

/**
 * Which reports a tracking token can reach.
 *
 * The `/tracked/**` endpoints used to accept exactly one hard-coded token and
 * serve one hard-coded report, so a report created through `POST /issues` returned
 * a token that led nowhere. That was survivable while the returned token was also
 * the fixture's constant; it stops being survivable the moment tokens are derived
 * per reporter, which is what makes a replay return the token the reporter already
 * has. So the token a create hands out has to actually open something, or the mock
 * would be modelling a system where filing a report as a citizen costs you access
 * to it.
 *
 * Keyed by token and holding a *list* per token, because that is the contract's
 * model: one token per device, many reports underneath it.
 */
const trackedReports = new Map<string, { summaries: IssueSummary[]; details: TrackedIssueDetail[] }>();

function seedTrackedReports(): void {
  // The seeded report, reachable by the documented fixture token, so the existing
  // `/tracked/**` behaviour and its tests are unchanged.
  trackedReports.set(MOCK_TRACKING_TOKEN, {
    summaries: [ISSUES[1]!],
    details: [TRACKED_ISSUE],
  });
}
seedTrackedReports();

/**
 * Make a just-created concealed report reachable by its token.
 *
 * Projected into the two shapes `/tracked/**` serves rather than stored as an
 * `IssueDetail`, because those are different projections of one report and the
 * endpoints have different contracts - the list is a summary, the detail is not.
 */
export function registerTrackedReport(token: string, issue: IssueDetail): void {
  const existing = trackedReports.get(token) ?? { summaries: [], details: [] };
  trackedReports.set(token, {
    summaries: [
      ...existing.summaries,
      { id: issue.id, publicCode: issue.publicCode, title: issue.title, status: issue.status, createdAt: issue.createdAt },
    ],
    details: [
      ...existing.details,
      { publicCode: issue.publicCode, title: issue.title, status: issue.status, createdAt: issue.createdAt },
    ],
  });
}

/** `null` for a token the mock has never issued, so callers can refuse it. */
export function trackedSummariesFor(token: string): IssueSummary[] | null {
  return trackedReports.get(token)?.summaries ?? null;
}

export function trackedDetailFor(token: string, issueId: string): TrackedIssueDetail | undefined {
  const reports = trackedReports.get(token);
  if (!reports) {
    return undefined;
  }
  const match = reports.summaries.find((summary) => summary.id === issueId);
  return match ? reports.details.find((detail) => detail.publicCode === match.publicCode) : undefined;
}

/** Back to just the seeded fixture report, for test isolation. */
export function resetTrackedReports(): void {
  trackedReports.clear();
  seedTrackedReports();
}

/**
 * The `IssueDetail` handed back by `POST /issues`.
 *
 * A builder rather than a constant, because the response has to agree with what
 * the reporter just submitted. A fixed fixture would have to be one of the two
 * things that is always true of a just-created issue - shared or concealed - and
 * whichever it was not, the other path would be handed an issue describing
 * something else. The concealed case is the one that matters most: the client's
 * whole post-submit behaviour keys off `contactState` and the
 * `contactVerificationRequired` flag, so a mock that returned a shared-shaped
 * issue for a concealed report would let the UI route to a status page that can
 * never resolve.
 *
 * Built from the submitted values, so the echo-back is real rather than
 * decorative. The address is deliberately *not* echoed: SPEC 7.1 says the contact
 * channel is never returned to anyone, and a mock that returned it would let a UI
 * grow comfortable displaying one.
 *
 * `photoCount` is the count that was *accepted*, which is a weaker claim than it
 * looks and is worth spelling out before a UI starts trusting it. The contract
 * carries the same caveat: a reporter who attaches two photos and reads back a
 * count of 2 knows the request carried two files, not that two images are visible
 * to an officer. This mock has no storage at all, so any stronger guarantee would
 * be something the mock invented and a real backend would not honour.
 *
 * An earlier version of this builder accepted a `photoCount` and dropped it, which
 * read as though the value were being returned and quietly lost. The limit was
 * enforced on the way in and the count fed the idempotency fingerprint, so the
 * information existed and was being discarded at the last step. That is fixed by
 * the field existing on `IssueDetail` at all - it was added to the contract for
 * this reason, since the create response is the only place a reporter can be told
 * their uploads arrived.
 */
export function createdIssue(details: {
  title: string;
  description: string;
  disclosure: Disclosure;
  categoryName?: string | null;
  proposedCategoryText?: string | null;
  latitude: number;
  longitude: number;
  address?: string | null;
  photoCount?: number;
}): IssueDetail {
  const concealed = details.disclosure === 'CONCEALED';
  const { id, publicCode } = nextCreatedReportIds();

  return {
    id,
    publicCode,
    title: details.title,
    description: details.description,
    // A concealed report is not yet out of any queue: the reporter has not
    // proved they own the address, so it sits in a contact *state* rather than
    // advancing into triage. Note `PENDING_VERIFICATION` is a `ContactState`, not
    // an `IssueStatus` - the report's own status is SUBMITTED and it never enters
    // an officer's queue. Conflating the two produces a status screen that can
    // never resolve, which is what `contactVerificationRequired` exists to stop.
    // The label says "Received" in both cases, because that is the only thing
    // true of a report nobody has looked at yet - and a reporter reading
    // "Under review" for a report no officer has seen is a promise the platform
    // cannot keep.
    status: 'SUBMITTED',
    statusLabel: 'Received',
    disclosure: details.disclosure,
    contactState: concealed ? 'PENDING_VERIFICATION' : undefined,
    categoryName: details.categoryName ?? null,
    proposedCategoryText: details.proposedCategoryText ?? null,
    latitude: details.latitude,
    longitude: details.longitude,
    address: details.address ?? null,
    reporterId: null,
    reporterDisplayName: null,
    confirmationCount: 0,
    photoCount: details.photoCount ?? 0,
    createdAt: at(0),
  };
}
