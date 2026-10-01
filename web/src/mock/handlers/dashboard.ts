import { http, HttpResponse } from 'msw';
import type { Dashboard } from '../../app/api/generated/types.gen';
import { API, forbidden, isStaffInScope, resolveCaller, unauthenticated } from '../http';
import { NOW, state, type StoredIssue } from '../store';

/**
 * `GET /dashboard`.
 *
 * ## Two problems this replaces
 *
 * **The shape was wrong.** The previous handler returned `openIssues`,
 * `resolvedThisMonth`, `breachesOpen` and `awaitingConfirmation` - none of which are
 * fields of the contract's `Dashboard`. A client typed against `Dashboard` read
 * `undefined` for the real ones and rendered an empty dashboard, while the mock
 * "worked" because nothing was reading it.
 *
 * **The numbers were literals.** 128 open, 46 resolved, 3 breaches, hard-coded. A
 * manager who assigned a report and returned to the dashboard saw the same 128,
 * which makes the dashboard useless for developing anything that depends on it - the
 * exact failure the mutable store exists to prevent. Everything here is counted from
 * `state.issues`.
 *
 * ## Role decides the scope, not just the fields
 *
 * The contract marks `slaBreachedCount`, `slaComplianceRate` and
 * `medianResolutionHours` as manager-and-admin-only, and `myAssignedCount` as
 * officer-only. Those are omitted below rather than zeroed: absent is how the
 * contract says "not available to you", and a `0` would render as a real measurement.
 */

/** Counts per status, over the caller's visible issues. */
function countByStatus(issues: StoredIssue[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const issue of issues) {
    counts[issue.status] = (counts[issue.status] ?? 0) + 1;
  }
  return counts;
}

/** The terminal statuses, per SPEC's lifecycle rather than a hard-coded list. */
const CLOSED_STATUSES = new Set(['CLOSED', 'REJECTED', 'DUPLICATE', 'CANCELLED']);

/** Resolved issues, in hours from creation to resolution. Empty when there are none. */
function resolutionHours(issues: StoredIssue[]): number[] {
  return issues
    .filter((issue) => issue.resolvedAt !== null)
    .map((issue) => (Date.parse(issue.resolvedAt!) - Date.parse(issue.createdAt)) / 3_600_000)
    .filter((hours) => Number.isFinite(hours) && hours >= 0);
}

/**
 * The median, or null.
 *
 * Null rather than 0 for an empty set, because the contract types it
 * `number | null` and a dashboard showing "median resolution: 0 hours" for a
 * department that has resolved nothing is a claim, and a false one.
 */
function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
  // Rounded to one decimal place: a median to four significant figures is noise on a
  // card, and the exact figure is in the reports the card links to.
  return Math.round(value * 10) / 10;
}

/**
 * SLA compliance as a fraction between 0 and 1.
 *
 * SPEC pairs "resolved within SLA" with "total resolved", so the denominator is
 * every resolved issue and the numerator the ones whose `SlaTracking.state` says they
 * were.
 *
 * Undefined when nothing has been resolved. `slaComplianceRate` is a plain `number`
 * in the contract, not `number | null`, so absent is the only way to say "no data" -
 * and `0` here would be the claim "none of our resolved issues met their SLA",
 * which is true only in the case where there were none.
 */
function complianceRate(issues: StoredIssue[]): number | undefined {
  const resolved = issues.filter((issue) => issue.resolvedAt !== null);
  if (resolved.length === 0) {
    return undefined;
  }
  const within = resolved.filter((issue) => issue.sla?.state === 'RESOLVED_WITHIN_SLA').length;
  return Math.round((within / resolved.length) * 1000) / 1000;
}

export const dashboardHandlers = [
  http.get(`${API}/dashboard`, ({ request }) => {
    const path = new URL(request.url).pathname;
    const caller = resolveCaller(request);
    if (!caller.userId) {
      return unauthenticated(path);
    }

    // The citizen dashboard is deliberately minimal: their own open reports, and
    // nothing about the department's. A citizen's dashboard is a citizen screen.
    if (caller.role === 'CITIZEN') {
      const mine = state.issues.filter((issue) => issue.reporterId !== null && issue.reporterId === caller.userId);
      const payload: Dashboard = {
        role: 'CITIZEN',
        totalOpen: mine.filter((issue) => !CLOSED_STATUSES.has(issue.status)).length,
        myOpenReports: mine.filter((issue) => !CLOSED_STATUSES.has(issue.status)).length,
        generatedAt: NOW,
      };
      return HttpResponse.json(payload);
    }

    if (caller.role !== 'FIELD_OFFICER' && caller.role !== 'DEPARTMENT_MANAGER' && caller.role !== 'ADMIN') {
      return forbidden(path);
    }

    // Scoped to what this caller may see: an officer sees their department, a manager
    // sees their department, an admin sees everything. Reusing `isStaffInScope` is
    // what keeps the dashboard's numbers agreeing with the queue they came from -
    // a dashboard counting 40 open while the officer's list shows 3 is worse than no
    // dashboard, because it looks authoritative.
    const visible = state.issues.filter((issue) => isStaffInScope(caller, issue));
    const open = visible.filter((issue) => !CLOSED_STATUSES.has(issue.status));
    const resolved = visible.filter((issue) => issue.resolvedAt !== null);

    const payload: Dashboard = {
      role: caller.role,
      scope: caller.user?.departmentName ?? 'All departments',
      totalOpen: open.length,
      byStatus: countByStatus(visible),
      byPriority: open.reduce<Record<string, number>>((counts, issue) => {
        counts[issue.priority] = (counts[issue.priority] ?? 0) + 1;
        return counts;
      }, {}),
      generatedAt: NOW,
    };

    if (caller.role === 'FIELD_OFFICER') {
      payload.myAssignedCount = visible.filter((issue) => issue.assignedOfficerId === caller.userId).length;
    } else {
      payload.slaBreachedCount = open.filter((issue) => issue.sla?.state === 'BREACHED').length;
      payload.slaComplianceRate = complianceRate(resolved);
      payload.medianResolutionHours = median(resolutionHours(resolved));
    }

    return HttpResponse.json(payload);
  }),
];
