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
 * The table is grouped by shell: each group names a layout component and its
 * `children` are the screens that render inside it. That grouping is the whole
 * point of a shell - a screen that is not a child of one renders with no
 * navigation, no `<main>` landmark and no skip link, which is a usable-looking
 * page that a keyboard or screen-reader user cannot get out of.
 *
 * It is worth being explicit that this was a real bug rather than a
 * specification that was never met. The five shells existed, and `app.spec.ts`
 * asserted their skip link, landmark labels and single-`h1` invariants in
 * isolation - and none of them was referenced by a single route. All 27
 * screens rendered bare. The suite was green and the application was
 * unreachable, because "the shell is correct" was never the same claim as "the
 * shell is used". `shell-wiring.spec.ts` now asserts the second thing.
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
 *
 * They sit on the children rather than on the group, deliberately. A guard on
 * `/officer` would send an officer who mistypes `/officer/asigned` to
 * "not authorised" instead of "no such page" - true, but the wrong answer to the
 * question actually asked, and it would make every typo in the staff area look
 * like an authorization failure.
 */
export const routes: Routes = [
  // --- Staff groups, declared first ---------------------------------------
  //
  // Order is load-bearing and the reason is the catch-all below. A `**` child
  // matches every remaining path, so the group that owns it has to be the last
  // entry in the table. With the citizen group declared first - which is where it
  // was, being the entry point - its `**` swallowed `/manager/queue` and rendered
  // "page not found" in the citizen frame: a department manager following a link
  // from an email landed on a 404. Angular matches in declaration order, so the
  // prefixed groups are declared first and the pathless group, which is the one
  // carrying the wildcard, is declared last.
  //
  // This is why "put the catch-all at the end" is a rule about the *table*, not
  // about the route: a wildcard nested in a pathless parent competes with every
  // sibling of that parent.
  {
    path: 'officer',
    loadComponent: () => import('./layouts/officer-shell').then((m) => m.OfficerShell),
    children: [
      {
        path: 'assigned',
        title: 'Assigned to me - CivicLens',
        canActivate: [roleGuard(...STAFF_ROLES)],
        loadComponent: () =>
          import('./features/officer/assigned-page').then((m) => m.AssignedPage),
      },
      {
        path: 'resolve/:issueId',
        title: 'Resolve issue - CivicLens',
        canActivate: [roleGuard(...STAFF_ROLES)],
        loadComponent: () =>
          import('./features/officer/resolve-page').then((m) => m.ResolvePage),
      },
      {
        path: '**',
        title: 'Page not found - CivicLens',
        loadComponent: () =>
          import('./features/errors/not-found-page').then((m) => m.NotFoundPage),
      },
    ],
  },

  // --- Manager ------------------------------------------------------------
  {
    path: 'manager',
    loadComponent: () => import('./layouts/manager-shell').then((m) => m.ManagerShell),
    children: [
      {
        path: 'queue',
        title: 'Department queue - CivicLens',
        canActivate: [roleGuard(...STAFF_ROLES)],
        loadComponent: () =>
          import('./features/manager/queue-page').then((m) => m.QueuePage),
      },
      {
        path: 'awaiting-confirmation',
        title: 'Awaiting confirmation - CivicLens',
        canActivate: [roleGuard(...STAFF_ROLES)],
        loadComponent: () =>
          import('./features/manager/awaiting-confirmation-page').then(
            (m) => m.AwaitingConfirmationPage,
          ),
      },
      {
        path: 'duplicates',
        title: 'Duplicate review - CivicLens',
        canActivate: [roleGuard(...STAFF_ROLES)],
        loadComponent: () =>
          import('./features/manager/duplicate-review-page').then(
            (m) => m.DuplicateReviewPage,
          ),
      },
      {
        path: 'analytics',
        title: 'Analytics - CivicLens',
        canActivate: [roleGuard(...STAFF_ROLES)],
        loadComponent: () =>
          import('./features/manager/analytics-page').then((m) => m.AnalyticsPage),
      },
      {
        path: 'categories',
        title: 'Category proposals - CivicLens',
        canActivate: [roleGuard(...STAFF_ROLES)],
        loadComponent: () =>
          import('./features/manager/category-proposals-page').then(
            (m) => m.CategoryProposalsPage,
          ),
      },
      {
        path: 'assignment',
        title: 'Assignment - CivicLens',
        canActivate: [roleGuard(...STAFF_ROLES)],
        loadComponent: () =>
          import('./features/manager/assignment-page').then((m) => m.AssignmentPage),
      },
      {
        path: 'sla-monitor',
        title: 'SLA monitor - CivicLens',
        canActivate: [roleGuard(...STAFF_ROLES)],
        loadComponent: () =>
          import('./features/manager/sla-monitor-page').then((m) => m.SlaMonitorPage),
      },
      {
        path: '**',
        title: 'Page not found - CivicLens',
        loadComponent: () =>
          import('./features/errors/not-found-page').then((m) => m.NotFoundPage),
      },
    ],
  },

  // --- Admin --------------------------------------------------------------
  {
    path: 'admin',
    loadComponent: () => import('./layouts/admin-shell').then((m) => m.AdminShell),
    children: [
      {
        path: 'users',
        title: 'Users - CivicLens',
        canActivate: [roleGuard(...ADMIN_ROLES)],
        loadComponent: () => import('./features/admin/users-page').then((m) => m.UsersPage),
      },
      {
        path: 'departments',
        title: 'Departments - CivicLens',
        canActivate: [roleGuard(...ADMIN_ROLES)],
        loadComponent: () =>
          import('./features/admin/departments-page').then((m) => m.DepartmentsPage),
      },
      {
        path: 'categories',
        title: 'Categories - CivicLens',
        canActivate: [roleGuard(...ADMIN_ROLES)],
        loadComponent: () =>
          import('./features/admin/categories-page').then((m) => m.CategoriesPage),
      },
      {
        path: 'sla',
        title: 'SLA policies - CivicLens',
        canActivate: [roleGuard(...ADMIN_ROLES)],
        loadComponent: () =>
          import('./features/admin/sla-page').then((m) => m.SlaPage),
      },
      {
        path: 'audit-logs',
        title: 'Audit log - CivicLens',
        canActivate: [roleGuard(...ADMIN_ROLES)],
        loadComponent: () =>
          import('./features/admin/audit-logs-page').then((m) => m.AuditLogsPage),
      },
      {
        path: '**',
        title: 'Page not found - CivicLens',
        loadComponent: () =>
          import('./features/errors/not-found-page').then((m) => m.NotFoundPage),
      },
    ],
  },

  // --- Citizen, path-less and last -----------------------------------------
  {
    // Path-less, so the citizen URLs stay exactly what the contract and the
    // emailed links already use: `/report`, not `/citizen/report`. The citizen
    // group also absorbs sign-in, notifications, the contact gate and both error
    // pages, because a signed-out visitor arriving from an email or a mistyped
    // URL still needs the same nav to get somewhere else.
    path: '',
    loadComponent: () => import('./layouts/citizen-shell').then((m) => m.CitizenShell),
    children: [
      {
        path: '',
        title: 'CivicLens - report an issue in your area',
        loadComponent: () =>
          import('./features/home/home-page').then((m) => m.HomePage),
      },
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

      // --- Contact: the approval gate ------------------------------------
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

      // --- Session --------------------------------------------------------
      {
        path: 'sign-in',
        title: 'Sign in - CivicLens',
        loadComponent: () =>
          import('./features/auth/sign-in-page').then((m) => m.SignInPage),
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

      // --- Terminal states ------------------------------------------------
      {
        path: 'not-authorised',
        title: 'Not authorised - CivicLens',
        loadComponent: () =>
          import('./features/errors/not-authorised-page').then((m) => m.NotAuthorisedPage),
      },
      {
        // The table's catch-all, and the reason this group is declared last: a
        // `**` here matches every path no earlier group claimed, so a mistyped
        // URL is a 404 *inside the nav* rather than a bare page with no way out.
        path: '**',
        title: 'Page not found - CivicLens',
        loadComponent: () =>
          import('./features/errors/not-found-page').then((m) => m.NotFoundPage),
      },
    ],
  },
];
