import { Component } from '@angular/core';
import { AppShell } from './app-shell';

/**
 * The department manager's shell (SPEC 3).
 *
 * Everything an officer can do, plus department-wide queue, assignment, SLA
 * monitoring, duplicate review and analytics. The links mirror the feature
 * folders in SPEC 14, so a new manager feature has somewhere obvious to appear.
 *
 * `staleResolvedOnly` is a queue view rather than an automatic transition:
 * SPEC's stance is that no timer closes a report, so the manager sees the
 * backlog of reports left resolved but never confirmed and nothing changes on
 * its own. Labelling it "needs attention" would be more honest than "stale".
 */
@Component({
  selector: 'app-manager-shell',
  imports: [AppShell],
  template: `
    <app-shell navLabel="Department manager" heading="Department queue" [links]="links">
      <ng-content />
    </app-shell>
  `,
})
export class ManagerShell {
  readonly links = [
    { path: '/manager/queue', label: 'Queue', exact: true },
    { path: '/manager/awaiting-confirmation', label: 'Needs confirmation' },
    { path: '/manager/duplicates', label: 'Duplicates' },
    { path: '/manager/analytics', label: 'Analytics' },
    { path: '/manager/categories', label: 'Category proposals' },
  ];
}
