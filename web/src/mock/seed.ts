import type {
  Category,
  Department,
  DuplicateMatch,
  IssueDetail,
  IssueStatus,
  Notification,
  SlaPolicy,
  TrackedIssueDetail,
} from '../app/api/generated/types.gen';
import { STATUS_LABELS } from './state-machine';
import {
  setState,
  type MockState,
  type StoredCategory,
  type StoredComment,
  type StoredDepartment,
  type StoredDuplicate,
  type StoredIssue,
  type StoredNotification,
  type StoredSlaPolicy,
  type StoredUser,
} from './store';

/**
 * The seeded world.
 *
 * Fixed timestamps throughout, so the same screenshot is reproducible next month
 * and a test that asserts on a date does not start failing on a Sunday.
 */

const T0 = Date.parse('2026-03-02T09:15:00Z');

function at(days: number, hours = 0): string {
  return new Date(T0 + days * 86_400_000 + hours * 3_600_000).toISOString();
}

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

/** The tracking token the mock server accepts on `/tracked/**` for the seeded report. */
export const MOCK_TRACKING_TOKEN = 'civiclens-mock-tracking-token-do-not-use';

/**
 * The token that verifies the seeded concealed report's contact channel.
 *
 * Stands in for the link in an email. Published because there is no inbox in a
 * development mock, and the alternative - a flow that cannot be completed - is
 * worse: the whole point of the verification gate is that a UI has to handle a
 * report sitting outside every queue until it is proven, and that is untestable
 * against a mock that cannot verify.
 */
export const MOCK_VERIFICATION_TOKEN = 'civiclens-mock-verify-token-do-not-use';

/** The token a reporter answers an officer's proposed fix through. */
export const MOCK_DECISION_TOKEN = 'civiclens-mock-decision-token-do-not-use';

/** The tracking token that owns the seeded reports, for `/tracked/**` tests. */
export const MOCK_TRACKING_TOKENS = [MOCK_TRACKING_TOKEN];

export const CITIZEN_EMAIL = 'reporter@example.org';
export const OFFICER_EMAIL = 'officer@civiclens.example.org';
export const MANAGER_EMAIL = 'manager@civiclens.example.org';
export const ADMIN_EMAIL = 'admin@civiclens.example.org';

/**
 * One seeded user per role, because the mock's bearer is `mock-token-<role>` and
 * carries no id. A second citizen would be invisible to every per-citizen rule -
 * idempotency scoping, comment authorship, "is this my report" - which is a real
 * limitation of a role-only token rather than something these fixtures fix.
 */
function seededUsers(departments: StoredDepartment[]): StoredUser[] {
  const roads = departments.find((d) => d.id === 'dept-roads');
  const base = { status: 'ACTIVE' as const, createdAt: at(-90), selfRegistered: false, password: MOCK_PASSWORD };
  return [
    {
      id: 'usr-citizen-1',
      email: CITIZEN_EMAIL,
      fullName: 'Sam Rivera',
      phone: null,
      role: 'CITIZEN',
      departmentId: null,
      departmentName: null,
      ...base,
    },
    {
      id: 'usr-officer-1',
      email: OFFICER_EMAIL,
      fullName: 'Priya Raman',
      phone: null,
      role: 'FIELD_OFFICER',
      departmentId: 'dept-roads',
      departmentName: roads?.name ?? 'Roads and Highways',
      ...base,
    },
    {
      id: 'usr-manager-1',
      email: MANAGER_EMAIL,
      fullName: 'Alex Doyle',
      phone: null,
      role: 'DEPARTMENT_MANAGER',
      departmentId: 'dept-roads',
      departmentName: roads?.name ?? 'Roads and Highways',
      ...base,
    },
    {
      id: 'usr-admin-1',
      email: ADMIN_EMAIL,
      fullName: 'Robin Vale',
      phone: null,
      role: 'ADMIN',
      departmentId: null,
      departmentName: null,
      ...base,
    },
  ];
}

function seededDepartments(): StoredDepartment[] {
  return [
    {
      id: 'dept-roads',
      name: 'Roads and Highways',
      code: 'ROADS',
      description: 'Pavements, kerbs, street lighting and signage.',
      active: true,
      staffCount: 2,
    },
    {
      id: 'dept-parks',
      name: 'Parks and Open Spaces',
      code: 'PARKS',
      description: 'Grounds, play areas and street furniture in parks.',
      active: true,
      staffCount: 0,
    },
    {
      id: 'dept-water',
      name: 'Water and Drainage',
      code: 'WATER',
      description: 'Retired in the fixture set so `/admin/departments` shows a non-active row.',
      active: false,
      staffCount: 0,
    },
  ];
}

function seededCategories(): StoredCategory[] {
  return [
    {
      id: 'cat-roads',
      name: 'Roads and pavements',
      code: 'ROADS',
      parentCategoryId: null,
      active: true,
      defaultDepartmentId: 'dept-roads',
      subcategories: [
        {
          id: 'cat-roads-pothole',
          name: 'Pothole',
          code: 'ROADS_POTHOLE',
          // Explicit rather than omitted. The contract flattens the tree, so the
          // parent link has to be carried on the child or a consumer has to guess it
          // from the ordering - and the report form's category picker depends on
          // knowing which parent a subcategory belongs to.
          parentCategoryId: 'cat-roads',
          defaultDepartmentId: 'dept-roads',
          active: true,
          subcategories: [],
        },
        {
          id: 'cat-roads-paving',
          name: 'Paving and kerbs',
          code: 'ROADS_PAVING',
          parentCategoryId: 'cat-roads',
          defaultDepartmentId: 'dept-roads',
          active: true,
          subcategories: [],
        },
      ],
    },
    {
      id: 'cat-lighting',
      name: 'Street lighting',
      code: 'LIGHTING',
      parentCategoryId: null,
      active: true,
      defaultDepartmentId: 'dept-roads',
      subcategories: [
        {
          id: 'cat-lighting-out',
          name: 'Light not working',
          code: 'LIGHTING_OUT',
          parentCategoryId: 'cat-lighting',
          defaultDepartmentId: 'dept-roads',
          active: true,
          subcategories: [],
        },
      ],
    },
    {
      // `OTHER` is the one category with no department behind it: a report filed
      // here has nothing to route to until a manager maps it, which is what makes
      // `proposedCategoryText` required rather than merely encouraged.
      id: 'cat-other',
      name: 'Something else',
      code: 'OTHER',
      parentCategoryId: null,
      active: true,
      defaultDepartmentId: null,
      subcategories: [],
    },
  ];
}

/**
 * Two reports, deliberately different in the one dimension that matters.
 *
 * `iss-shared-1` is shared, `iss-concealed-1` is concealed. Both seeded with the
 * reporter's own id, so "is this my report" is testable; the concealed one stores
 * `reporterId: null` and a contact channel that is *never* projected into a
 * response. A mock that rendered a reporter name on the concealed one is the bug
 * this pairing makes visible rather than theoretical.
 */
function seededIssues(categories: StoredCategory[]): StoredIssue[] {
  const roads = categories.find((c) => c.id === 'cat-roads');
  const lighting = categories.find((c) => c.id === 'cat-lighting');

  return [
    {
      id: 'iss-shared-1',
      publicCode: 'CL-2026-0001',
      title: 'Pothole outside 14 Elm Road',
      description:
        'The pothole is about a foot wide and deep enough to catch a bicycle wheel. It is right outside the pharmacy entrance.',
      status: 'IN_PROGRESS',
      statusLabel: STATUS_LABELS['IN_PROGRESS'],
      priority: 'MEDIUM',
      priorityScore: 55,
      priorityBreakdown: null,
      severity: 'MEDIUM',
      categoryId: roads?.id ?? null,
      categoryName: roads?.name ?? null,
      subcategoryId: 'cat-roads-pothole',
      subcategoryName: 'Pothole',
      proposedCategoryText: null,
      disclosure: 'SHARE_DETAILS',
      latitude: 51.5074,
      longitude: -0.1278,
      address: '14 Elm Road',
      areaLabel: 'Elm Road',
      reporterId: 'usr-citizen-1',
      reporterDisplayName: 'Sam Rivera',
      assignedDepartmentId: 'dept-roads',
      assignedDepartmentName: 'Roads and Highways',
      assignedOfficerId: 'usr-officer-1',
      assignedOfficerName: 'Priya Raman',
      confirmationCount: 6,
      photoCount: 2,
      aiUnavailable: false,
      aiSuggestions: [],
      attachments: [],
      statusHistory: [
        {
          id: 'ste-1',
          toStatus: 'SUBMITTED',
          changedById: null,
          changedByName: 'CivicLens',
          reason: 'Report received.',
          createdAt: at(-6),
        },
        {
          id: 'ste-2',
          fromStatus: 'SUBMITTED',
          toStatus: 'AI_ANALYZING',
          changedById: null,
          changedByName: 'CivicLens',
          reason: 'Being reviewed.',
          createdAt: at(-6, -1),
        },
        {
          id: 'ste-3',
          fromStatus: 'AI_ANALYZING',
          toStatus: 'TRIAGED',
          changedById: 'usr-manager-1',
          changedByName: 'Alex Doyle',
          reason: 'Confirmed as a road defect.',
          createdAt: at(-5),
        },
        {
          id: 'ste-4',
          fromStatus: 'TRIAGED',
          toStatus: 'ASSIGNED',
          changedById: 'usr-manager-1',
          changedByName: 'Alex Doyle',
          reason: 'Routed to the patch crew.',
          createdAt: at(-4),
        },
        {
          id: 'ste-5',
          fromStatus: 'ASSIGNED',
          toStatus: 'IN_PROGRESS',
          changedById: 'usr-officer-1',
          changedByName: 'Priya Raman',
          reason: 'Crew scheduled.',
          createdAt: at(-2),
        },
      ],
      sla: {
        deadline: at(1),
        state: 'WITHIN_SLA',
        resolveWithinHours: 72,
        lastEvaluatedAt: at(0),
      },
      resolutionReport: null,
      contactState: undefined,
      approvalDeadline: null,
      createdAt: at(-6),
      updatedAt: at(-2),
      resolvedAt: null,
      closedAt: null,
      reopenWindowEndsAt: null,
      awaitingConfirmation: false,
      contactEmail: null,
      revealRequested: false,
      createKey: null,
      now: '2026-03-02T09:15:00.000Z',
    },
    {
      id: 'iss-concealed-1',
      publicCode: 'CL-2026-0002',
      title: 'Street light out on the estate road',
      description:
        'The street light outside the play area has been out for about a week. It is very dark when I walk the dog in the evening.',
      status: 'AI_ANALYZING',
      statusLabel: STATUS_LABELS['AI_ANALYZING'],
      priority: 'LOW',
      priorityScore: 22,
      priorityBreakdown: null,
      severity: 'LOW',
      categoryId: lighting?.id ?? null,
      categoryName: lighting?.name ?? null,
      subcategoryId: 'cat-lighting-out',
      subcategoryName: 'Light not working',
      proposedCategoryText: null,
      disclosure: 'CONCEALED',
      latitude: 51.5231,
      longitude: -0.0994,
      address: null,
      areaLabel: 'Hawthorn Estate',
      // Null, not a sentinel. SPEC 3: concealed is stored as a null reporter so no
      // join or query can accidentally treat it as a real account.
      reporterId: null,
      reporterDisplayName: null,
      assignedDepartmentId: null,
      assignedDepartmentName: null,
      assignedOfficerId: null,
      assignedOfficerName: null,
      confirmationCount: 1,
      photoCount: 0,
      aiUnavailable: false,
      aiSuggestions: [],
      attachments: [],
      statusHistory: [
        {
          id: 'ste-6',
          toStatus: 'SUBMITTED',
          changedById: null,
          changedByName: 'CivicLens',
          reason: 'Report received.',
          createdAt: at(-1),
        },
        {
          id: 'ste-7',
          fromStatus: 'SUBMITTED',
          toStatus: 'AI_ANALYZING',
          changedById: null,
          changedByName: 'CivicLens',
          reason: 'Being reviewed.',
          createdAt: at(-1, -1),
        },
      ],
      sla: null,
      resolutionReport: null,
      // The report sits outside every queue until the channel is proven.
      contactState: 'PENDING_VERIFICATION',
      approvalDeadline: null,
      createdAt: at(-1),
      updatedAt: at(-1),
      resolvedAt: null,
      closedAt: null,
      reopenWindowEndsAt: null,
      awaitingConfirmation: false,
      // Held only so `/contact/verify` can match a token to this channel. Never
      // projected into any response.
      contactEmail: 'concealed-reporter@example.org',
      revealRequested: false,
      createKey: null,
      now: '2026-03-02T09:15:00.000Z',
    },
    {
      // A RESOLVED *concealed* report, owned by the tracking token.
      //
      // This exists so `/tracked/issues/{id}/confirm` and `/reopen` are reachable at
      // all. The other concealed report is `AI_ANALYZING` with no department and no
      // officer, and nothing in the contract can move it forward: triage is
      // system-driven with no operation, `assignIssue` needs a department to match, and
      // `resolveIssue` needs the assignee. Without this row those two operations are
      // unreachable dead code, so a concealed reporter could never close their own
      // report - the one thing the tracked tree exists to let them do.
      id: 'iss-concealed-resolved',
      publicCode: 'CL-2026-0004',
      title: 'Dark alley behind the parade of shops',
      description: 'The alley is unlit after nine in the evening and it feels unsafe walking home.',
      status: 'RESOLVED',
      statusLabel: STATUS_LABELS['RESOLVED'],
      priority: 'MEDIUM',
      priorityScore: 48,
      priorityBreakdown: null,
      severity: 'MEDIUM',
      categoryId: lighting?.id ?? null,
      categoryName: lighting?.name ?? null,
      subcategoryId: 'cat-lighting-out',
      subcategoryName: 'Street lighting not working',
      proposedCategoryText: null,
      disclosure: 'CONCEALED',
      latitude: 51.5123,
      longitude: -0.1145,
      address: null,
      areaLabel: 'Parade of shops',
      reporterId: null,
      reporterDisplayName: 'Concealed reporter',
      assignedDepartmentId: 'dept-roads',
      assignedDepartmentName: 'Roads and Highways',
      assignedOfficerId: 'usr-officer-1',
      assignedOfficerName: 'Priya Raman',
      confirmationCount: 0,
      photoCount: 0,
      aiUnavailable: false,
      aiSuggestions: [],
      attachments: [],
      statusHistory: [
        {
          id: 'ste-c1',
          toStatus: 'SUBMITTED',
          changedById: null,
          changedByName: 'Concealed reporter',
          reason: 'Report received.',
          createdAt: at(-21),
        },
        {
          id: 'ste-c2',
          toStatus: 'RESOLVED',
          changedById: 'usr-officer-1',
          changedByName: 'Priya Raman',
          reason: 'A second lamp fitted and tested after dark.',
          createdAt: at(-2),
        },
      ],
      sla: {
        deadline: at(-17),
        state: 'RESOLVED_WITHIN_SLA',
        resolveWithinHours: 48,
        lastEvaluatedAt: at(-2),
      },
      resolutionReport: {
        id: 'res-concealed-1',
        notes: 'A second lamp fitted and tested after dark.',
        aiSummary: null,
        officerId: 'usr-officer-1',
        officerName: 'Priya Raman',
        submittedAt: at(-2),
      },
      contactState: 'VERIFIED',
      contactEmail: 'concealed-resolved@example.org',
      // resolvedAt + REOPEN_WINDOW_DAYS.
      approvalDeadline: at(12),
      createdAt: at(-21),
      updatedAt: at(-2),
      resolvedAt: at(-2),
      closedAt: null,
      reopenWindowEndsAt: at(12),
      awaitingConfirmation: true,
      revealRequested: false,
      createKey: null,
      now: '2026-03-02T09:15:00.000Z',
    },
    {
      // A RESOLVED shared report, so the approval gate has something to act on
      // without a test having to drive four transitions first.
      id: 'iss-shared-2',
      publicCode: 'CL-2026-0003',
      title: 'Loose paving slab on Mill Lane',
      description: 'One slab is rocking badly outside number 22. Someone is going to trip on it.',
      status: 'RESOLVED',
      statusLabel: STATUS_LABELS['RESOLVED'],
      priority: 'HIGH',
      priorityScore: 71,
      priorityBreakdown: null,
      severity: 'HIGH',
      categoryId: roads?.id ?? null,
      categoryName: roads?.name ?? null,
      subcategoryId: 'cat-roads-paving',
      subcategoryName: 'Paving and kerbs',
      proposedCategoryText: null,
      disclosure: 'SHARE_DETAILS',
      latitude: 51.5101,
      longitude: -0.1201,
      address: '22 Mill Lane',
      areaLabel: 'Mill Lane',
      reporterId: 'usr-citizen-1',
      reporterDisplayName: 'Sam Rivera',
      assignedDepartmentId: 'dept-roads',
      assignedDepartmentName: 'Roads and Highways',
      assignedOfficerId: 'usr-officer-1',
      assignedOfficerName: 'Priya Raman',
      confirmationCount: 2,
      photoCount: 1,
      aiUnavailable: false,
      aiSuggestions: [],
      attachments: [],
      statusHistory: [
        {
          id: 'ste-8',
          toStatus: 'SUBMITTED',
          changedById: 'usr-citizen-1',
          changedByName: 'Sam Rivera',
          reason: 'Report received.',
          createdAt: at(-20),
        },
        {
          id: 'ste-9',
          fromStatus: 'SUBMITTED',
          toStatus: 'AI_ANALYZING',
          changedById: null,
          changedByName: 'CivicLens',
          reason: 'Being reviewed.',
          createdAt: at(-20, -1),
        },
        {
          id: 'ste-10',
          fromStatus: 'AI_ANALYZING',
          toStatus: 'TRIAGED',
          changedById: 'usr-manager-1',
          changedByName: 'Alex Doyle',
          reason: null,
          createdAt: at(-19),
        },
        {
          id: 'ste-11',
          fromStatus: 'TRIAGED',
          toStatus: 'ASSIGNED',
          changedById: 'usr-manager-1',
          changedByName: 'Alex Doyle',
          reason: null,
          createdAt: at(-18),
        },
        {
          id: 'ste-12',
          fromStatus: 'ASSIGNED',
          toStatus: 'IN_PROGRESS',
          changedById: 'usr-officer-1',
          changedByName: 'Priya Raman',
          reason: null,
          createdAt: at(-17),
        },
        {
          id: 'ste-13',
          fromStatus: 'IN_PROGRESS',
          toStatus: 'RESOLVED',
          changedById: 'usr-officer-1',
          changedByName: 'Priya Raman',
          reason: 'Slab lifted and re-bedded.',
          createdAt: at(-1),
        },
      ],
      sla: {
        deadline: at(-17),
        state: 'RESOLVED_WITHIN_SLA',
        resolveWithinHours: 48,
        lastEvaluatedAt: at(-1),
      },
      resolutionReport: {
        id: 'res-1',
        notes: 'Slab lifted, base re-compacted and re-bedded. Checked level with a straight edge.',
        aiSummary: null,
        officerId: 'usr-officer-1',
        officerName: 'Priya Raman',
        submittedAt: at(-1),
      },
      contactState: undefined,
      // resolvedAt + REOPEN_WINDOW_DAYS. Surfaced to the reporter as a real date,
      // because a right that expires without ever being announced is not a right.
      approvalDeadline: at(13),
      createdAt: at(-20),
      updatedAt: at(-1),
      resolvedAt: at(-1),
      closedAt: null,
      reopenWindowEndsAt: at(13),
      awaitingConfirmation: true,
      contactEmail: null,
      revealRequested: false,
      createKey: null,
      now: '2026-03-02T09:15:00.000Z',
    },
  ];
}

/**
 * Three comments, one per visibility case.
 *
 * The INTERNAL one is the point of the whole file: a mock comment thread with no
 * internal note cannot demonstrate that `/tracked/**` filters it, and the filter
 * is the single most damaging bug that endpoint could have.
 */
function seededComments(): StoredComment[] {
  return [
    {
      id: 'cmt-1',
      body: 'Thanks for the report. An inspector is booked for tomorrow morning.',
      visibility: 'PUBLIC',
      authorId: 'usr-manager-1',
      authorName: 'Alex Doyle',
      authorRole: 'DEPARTMENT_MANAGER',
      concealedAuthor: false,
      createdAt: at(-5),
      editedAt: null,
      revisionCount: 0,
      editWindowEndsAt: null,
      deletedAt: null,
      concealedByToken: null,
      revisions: [],
      issueId: 'iss-shared-1',
    },
    {
      id: 'cmt-2',
      body: 'Crew capacity is the constraint this week. Do not promise a date to the reporter.',
      visibility: 'INTERNAL',
      authorId: 'usr-manager-1',
      authorName: 'Alex Doyle',
      authorRole: 'DEPARTMENT_MANAGER',
      concealedAuthor: false,
      createdAt: at(-5),
      editedAt: null,
      revisionCount: 0,
      editWindowEndsAt: null,
      deletedAt: null,
      concealedByToken: null,
      revisions: [],
      issueId: 'iss-shared-1',
    },
    {
      id: 'cmt-3',
      body: 'Is the light still out this evening? I can check again after dark.',
      visibility: 'PUBLIC',
      authorId: null,
      authorName: 'Concealed reporter',
      authorRole: 'CITIZEN',
      concealedAuthor: true,
      createdAt: at(-1),
      editedAt: null,
      revisionCount: 0,
      editWindowEndsAt: null,
      deletedAt: null,
      concealedByToken: MOCK_TRACKING_TOKEN,
      revisions: [],
      issueId: 'iss-concealed-1',
    },
  ];
}

function seededDuplicates(): StoredDuplicate[] {
  return [
    {
      id: 'dup-1',
      issueId: 'iss-shared-2',
      issuePublicCode: 'CL-2026-0003',
      candidateIssueId: 'iss-shared-1',
      candidatePublicCode: 'CL-2026-0001',
      candidateTitle: 'Pothole outside 14 Elm Road',
      candidateStatus: 'IN_PROGRESS',
      // Both numbers, because two identical descriptions 400m apart are not the
      // same problem and a manager judging the match needs to see the distance.
      similarityScore: 0.71,
      distanceMeters: 412,
      detectionMethod: 'RULE_BASED',
      status: 'SUGGESTED',
      reviewedById: null,
      reviewedAt: null,
      createdAt: at(-19),
    },
  ];
}

/** The four per-priority defaults, which are what make a new category sane. */
function seededSlaPolicies(categories: StoredCategory[]): StoredSlaPolicy[] {
  const priorities = [
    { priority: 'LOW' as const, hours: 240 },
    { priority: 'MEDIUM' as const, hours: 120 },
    { priority: 'HIGH' as const, hours: 48 },
    { priority: 'CRITICAL' as const, hours: 8 },
  ];
  const defaults = priorities.map((entry) => ({
    id: `sla-${entry.priority.toLowerCase()}-default`,
    categoryId: null,
    categoryName: null,
    priority: entry.priority,
    resolveWithinHours: entry.hours,
  }));
  const roads = categories.find((c) => c.id === 'cat-roads');
  return [
    ...defaults,
    {
      id: 'sla-roads-high',
      categoryId: roads?.id ?? null,
      categoryName: roads?.name ?? null,
      priority: 'HIGH' as const,
      resolveWithinHours: 24,
    },
  ];
}

function seededNotifications(): StoredNotification[] {
  return [
    {
      id: 'ntf-1',
      type: 'ISSUE_RESOLVED',
      channel: 'IN_APP',
      title: 'A fix has been proposed for your report',
      body: 'Roads and Highways marked the loose slab on Mill Lane as repaired. You have fourteen days to confirm it.',
      read: false,
      payload: { issueId: 'iss-shared-2' },
      createdAt: at(-1, 2),
    },
    {
      id: 'ntf-2',
      type: 'ISSUE_ASSIGNED',
      channel: 'IN_APP',
      title: 'Your report has been assigned',
      body: 'Roads and Highways are now looking at your report.',
      read: true,
      payload: { issueId: 'iss-shared-1' },
      createdAt: at(-4),
    },
  ];
}

function seededAuditLogs(): {
  id: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}[] {
  return [
    {
      id: 'aud-1',
      actorId: 'usr-manager-1',
      actorName: 'Alex Doyle',
      action: 'ISSUE_ASSIGNED',
      entityType: 'Issue',
      entityId: 'iss-shared-1',
      oldValue: null,
      newValue: { assignedOfficerId: 'usr-officer-1' },
      ipAddress: '198.51.100.24',
      createdAt: at(-4),
    },
    {
      id: 'aud-2',
      // A concealed report's audit row carries no IP. A reporter's IP is the only
      // identity such a report has, so recording it here would leave the
      // concealment one records request away.
      actorId: null,
      actorName: null,
      action: 'ISSUE_CREATED',
      entityType: 'Issue',
      entityId: 'iss-concealed-1',
      oldValue: null,
      newValue: { disclosure: 'CONCEALED' },
      ipAddress: null,
      createdAt: at(-1),
    },
  ];
}

/** Build the seeded world. Called on first import and by `resetMockState()`. */
export function seedState(): MockState {
  const departments = seededDepartments();
  const categories = seededCategories();

  return {
    users: seededUsers(departments),
    departments,
    categories,
    issues: seededIssues(categories),
    comments: seededComments(),
    duplicates: seededDuplicates(),
    slaPolicies: seededSlaPolicies(categories),
    auditLogs: seededAuditLogs(),
    notifications: seededNotifications(),
    deviceTokens: [],
    verificationTokens: new Map([
      [
        MOCK_VERIFICATION_TOKEN,
        {
          issueId: 'iss-concealed-1',
          email: 'concealed-reporter@example.org',
          expiresAt: at(6),
          used: false,
        },
      ],
    ]),
    decisionTokens: new Map([
      [MOCK_DECISION_TOKEN, { issueId: 'iss-shared-2', expiresAt: at(13), used: false }],
    ]),
    // The seeded concealed report is reachable by the documented fixture token.
    // One token, two reports: SPEC allows a single tracking token to own more than one
  // report, and that is what lets a reporter who filed twice stay in one place.
  trackedTokens: new Map([
    [MOCK_TRACKING_TOKEN, ['iss-concealed-1', 'iss-concealed-resolved']],
  ]),
    sequence: { issue: 100, comment: 10, revision: 0, audit: 10, user: 10, duplicate: 10, trace: 0 },
  };
}

setState(seedState());

/** Back to the seeded world, for test isolation. */
export function resetMockState(): void {
  setState(seedState());
}

/** Whether a status is one a queue filters on. Re-exported for the handlers. */
export function isOpenStatus(status: IssueStatus): boolean {
  return !['CLOSED', 'REJECTED', 'DUPLICATE', 'CANCELLED'].includes(status);
}