import { type Routes } from '@angular/router';
import { roleGuard, ADMIN_ROLES, STAFF_ROLES } from './core/auth/role.guard';

/**
 * The route table.
 *
 * Every feature is lazily loaded (`loadComponent`), which is what keeps the
 * citizen's first load small. This is a civic service that has to work on a
 * cheap phone over a slow connection, and the officer and admin bundles are the
 * largest code in the app while being the least used.
 *
 * Two rules govern the paths themselves:
 *
 * 1. **A tracking token is never in a path.** SPEC 14 requires it, so
 *    `/tracked/**` routes carry only an issue id. `TrackingTokenStore` has no
 *    method that can read a token out of a URL, and `session-policy.spec.ts`
 *    fails the build if one is added.
 *
 * 2. **The contact routes are the one deliberate exception.** They are reached
 *    from an emailed single-use token, which is consumed on arrival and then
 *    stripped from the URL. That is narrow and intentional: making the approval
 *    link depend on the tracking token would fail on the different device the
 *    link is usually opened on. What the token grants is no report content - no
 *    body, no comments, no status.
 *
 * Guards are UX, not security (SPEC 3): they save a signed-in citizen from a
 * page that would fail every request. The server decides authorization.
 */
export const routes: Routes = [
  {
    path: '',
    title: 'CivicLens - report an issue in your area',
    loadComponent: () =>
      import('./features/home/home-page').then((m) => m.HomePage),
  },

  // --- Citizen ------------------------------------------------------------
  {
    path: 'report',
    title: 'Report an issue - CivicLens',
    loadComponent: () =>
      import('./features/issues/report-issue-page').then((m) => m.ReportIssuePage),
  },
  {
    path: 'tracked',
    title: 'Track a report - CivicLens',
    loadComponent: () =>
      import('./features/tracked/tracked-list-page').then((m) => m.TrackedListPage),
  },
  {
    path: 'tracked/:issueId',
    title: 'Your report - CivicLens',
    loadComponent: () =>
      import('./features/tracked/tracked-detail-page').then((m) => m.TrackedDetailPage),
  },
  {
    path: 'public',
    title: 'Public reports - CivicLens',
    loadComponent: () =>
      import('./features/issues/public-issue-page').then((m) => m.PublicIssuePage),
  },
  {
    path: 'public/:publicCode',
    title: 'Public report - CivicLens',
    loadComponent: () =>
      import('./features/issues/public-issue-detail-page').then(
        (m) => m.PublicIssueDetailPage,
      ),
  },

  // --- Contact: the approval gate ----------------------------------------
  {
    path: 'contact/verify',
    title: 'Confirm your report - CivicLens',
    loadComponent: () =>
      import('./features/contact/contact-verify-page').then((m) => m.ContactVerifyPage),
  },
  {
    path: 'contact/decision',
    title: 'Approve sharing your details - CivicLens',
    loadComponent: () =>
      import('./features/contact/contact-decision-page').then(
        (m) => m.ContactDecisionPage,
      ),
  },

  // --- Session ------------------------------------------------------------
  {
    path: 'sign-in',
    title: 'Sign in - CivicLens',
    loadComponent: () => import('./features/auth/sign-in-page').then((m) => m.SignInPage),
  },
  {
    path: 'my-reports',
    title: 'My reports - CivicLens',
    canActivate: [roleGuard()],
    loadComponent: () =>
      import('./features/issues/my-reports-page').then((m) => m.MyReportsPage),
  },
  {
    path: 'notifications',
    title: 'Notifications - CivicLens',
    canActivate: [roleGuard()],
    loadComponent: () =>
      import('./features/notifications/notifications-page').then(
        (m) => m.NotificationsPage,
      ),
  },

  // --- Officer ------------------------------------------------------------
  {
    path: 'officer/assigned',
    title: 'Assigned to me - CivicLens',
    canActivate: [roleGuard(...STAFF_ROLES)],
    loadComponent: () =>
      import('./features/officer/assigned-page').then((m) => m.AssignedPage),
  },
  {
    path: 'officer/resolve/:issueId',
    title: 'Resolve issue - CivicLens',
    canActivate: [roleGuard(...STAFF_ROLES)],
    loadComponent: () =>
      import('./features/officer/resolve-page').then((m) => m.ResolvePage),
  },

  // --- Manager ------------------------------------------------------------
  {
    path: 'manager/queue',
    title: 'Department queue - CivicLens',
    canActivate: [roleGuard(...STAFF_ROLES)],
    loadComponent: () => import('./features/manager/queue-page').then((m) => m.QueuePage),
  },
  {
    path: 'manager/awaiting-confirmation',
    title: 'Awaiting confirmation - CivicLens',
    canActivate: [roleGuard(...STAFF_ROLES)],
    loadComponent: () =>
      import('./features/manager/awaiting-confirmation-page').then(
        (m) => m.AwaitingConfirmationPage,
      ),
  },
  {
    path: 'manager/duplicates',
    title: 'Duplicate review - CivicLens',
    canActivate: [roleGuard(...STAFF_ROLES)],
    loadComponent: () =>
      import('./features/manager/duplicate-review-page').then(
        (m) => m.DuplicateReviewPage,
      ),
  },
  {
    path: 'manager/analytics',
    title: 'Analytics - CivicLens',
    canActivate: [roleGuard(...STAFF_ROLES)],
    loadComponent: () =>
      import('./features/manager/analytics-page').then((m) => m.AnalyticsPage),
  },
  {
    path: 'manager/categories',
    title: 'Category proposals - CivicLens',
    canActivate: [roleGuard(...STAFF_ROLES)],
    loadComponent: () =>
      import('./features/manager/category-proposals-page').then(
        (m) => m.CategoryProposalsPage,
      ),
  },
  {
    path: 'manager/assignment',
    title: 'Assignment - CivicLens',
    canActivate: [roleGuard(...STAFF_ROLES)],
    loadComponent: () =>
      import('./features/manager/assignment-page').then((m) => m.AssignmentPage),
  },
  {
    path: 'manager/sla-monitor',
    title: 'SLA monitor - CivicLens',
    canActivate: [roleGuard(...STAFF_ROLES)],
    loadComponent: () =>
      import('./features/manager/sla-monitor-page').then((m) => m.SlaMonitorPage),
  },

  // --- Admin --------------------------------------------------------------
  {
    path: 'admin/users',
    title: 'Users - CivicLens',
    canActivate: [roleGuard(...ADMIN_ROLES)],
    loadComponent: () => import('./features/admin/users-page').then((m) => m.UsersPage),
  },
  {
    path: 'admin/departments',
    title: 'Departments - CivicLens',
    canActivate: [roleGuard(...ADMIN_ROLES)],
    loadComponent: () =>
      import('./features/admin/departments-page').then((m) => m.DepartmentsPage),
  },
  {
    path: 'admin/categories',
    title: 'Categories - CivicLens',
    canActivate: [roleGuard(...ADMIN_ROLES)],
    loadComponent: () =>
      import('./features/admin/categories-page').then((m) => m.CategoriesPage),
  },
  {
    path: 'admin/sla',
    title: 'SLA policies - CivicLens',
    canActivate: [roleGuard(...ADMIN_ROLES)],
    loadComponent: () => import('./features/admin/sla-page').then((m) => m.SlaPage),
  },
  {
    path: 'admin/audit-logs',
    title: 'Audit log - CivicLens',
    canActivate: [roleGuard(...ADMIN_ROLES)],
    loadComponent: () =>
      import('./features/admin/audit-logs-page').then((m) => m.AuditLogsPage),
  },

  // --- Terminal states ----------------------------------------------------
  {
    path: 'not-authorised',
    title: 'Not authorised - CivicLens',
    loadComponent: () =>
      import('./features/errors/not-authorised-page').then((m) => m.NotAuthorisedPage),
  },
  {
    path: '**',
    title: 'Page not found - CivicLens',
    loadComponent: () =>
      import('./features/errors/not-found-page').then((m) => m.NotFoundPage),
  },
];
