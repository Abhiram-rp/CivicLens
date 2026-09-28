import type {
  Category,
  CurrentUser,
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
