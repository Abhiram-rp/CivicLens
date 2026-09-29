import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AppShell } from './app-shell';

/**
 * The administrator's shell (SPEC 3).
 *
 * Configuration and audit only. Administration is admin-only, audited, and never
 * reachable through self-service profile update, so this is the one shell where
 * "everything else" is genuinely everything: the absence of queue and resolution
 * links is a reflection of the role table, not an oversight.
 *
 * The audit log is listed first among the operational links because the two
 * things an administrator most often needs are "who is in the system" and "what
 * did they do".
 */
  @Component({
    selector: 'app-admin-shell',
    imports: [AppShell, RouterOutlet],
    template: `
      <app-shell navLabel="Administrator" heading="Configuration" [links]="links">
        <router-outlet />
      </app-shell>
    `,
  })
export class AdminShell {
  readonly links = [
    { path: '/admin/audit-logs', label: 'Audit log', icon: 'file-text', exact: true },
    { path: '/admin/users', label: 'Users', icon: 'user' },
    { path: '/admin/departments', label: 'Departments', icon: 'environment' },
    { path: '/admin/categories', label: 'Categories', icon: 'menu' },
    { path: '/admin/sla', label: 'SLA policies', icon: 'setting' },
  ];
}
