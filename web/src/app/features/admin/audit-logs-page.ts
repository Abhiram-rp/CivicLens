import { Component } from '@angular/core';
import { NotYet } from '../../shared/not-yet';

/**
 * AuditLogsPage - scaffold placeholder.
 *
 * The route, its title, its guard and its lazy chunk are real; the screen is not
 * built yet. Scheduled for P2 per SPEC 15 - the audit log is listed under P2
 * "Triage and Workflow", not P1. It was labelled P1, which put an audit surface in
 * front of a reader as part of the first release when the workflow that writes those
 * rows does not ship until the next one.
 *
 * The operations listed by `app-not-yet` are the contract surface this screen will
 * call.
 *
 * Navigation is the shell's business, so this page contributes content only.
 */
@Component({
  selector: 'app-audit-logs-page',
  imports: [NotYet],
  template: `
    <app-not-yet [phase]="'P2'" [operations]="operations" />
  `,
})
export class AuditLogsPage {
  protected readonly operations: ReadonlyArray<string> = ['listAuditLogs'];
}
