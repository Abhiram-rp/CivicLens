import type { IssueDetail, ReporterContact } from '../app/api/generated/types.gen';
import { state, type StoredIssue } from './store';

/**
 * Tracking-token registration.
 *
 * Split out of `idempotency.ts` and out of `fixtures.ts` because it is the join
 * between two things that used to be separate: the idempotency module that mints
 * a token, and the `/tracked/**` tree that has to be able to open something with
 * it.
 *
 * ## Why this has to exist
 *
 * `POST /issues` returns a `trackingToken` **exactly once** in the life of a
 * concealed report, and it is unrecoverable afterwards. That makes the create
 * response the only chance the reporter has, and it means the token must open
 * real data from the moment it is handed over. An earlier mock issued a token and
 * registered nothing, which modelled a system where filing a report as a citizen
 * costs you access to it - and it was invisible, because the fixture's own
 * constant token did open the one seeded report, so the tracked screen looked fine.
 *
 * ## One token, many reports
 *
 * A token is per *device*, not per report, so this holds a list. A citizen who
 * files three reports from one phone gets one token and three reports under it.
 * Keying by report instead would mean the second report's token could not see the
 * first, which is both wrong and the kind of wrong that looks right in a test
 * that only ever files one report.
 */
export function registerTrackedReport(token: string, issue: IssueDetail | StoredIssue): void {
  const existing = state.trackedTokens.get(token) ?? [];
  if (!existing.includes(issue.id)) {
    state.trackedTokens.set(token, [...existing, issue.id]);
  }
}

/** Whether a token owns a report. The only question `/tracked/**` asks. */
export function tokenOwnsReport(token: string, issueId: string): boolean {
  return (state.trackedTokens.get(token) ?? []).includes(issueId);
}

/** Every report under a token, in creation order. */
export function reportsForToken(token: string): StoredIssue[] {
  const ids = state.trackedTokens.get(token) ?? [];
  return ids
    .map((id) => state.issues.find((issue) => issue.id === id))
    .filter((issue): issue is StoredIssue => issue !== undefined);
}

/**
 * The contact channel a concealed report is reachable at.
 *
 * Set at create time so `/contact/verify` has something to match a token against.
 * Held on the store and dropped by every projection - SPEC 7.1 says the address is
 * never echoed to anyone, not even the reporter who supplied it, because a
 * response that returns it is a response that ends up in a log.
 */
export function setContactEmail(issue: StoredIssue, contact: ReporterContact | undefined): void {
  issue.contactEmail = contact?.type === 'EMAIL' ? contact.value : null;
}

/** Forget every token registration, for test isolation. */
export function resetTrackedTokens(): void {
  // Re-seed rather than clear: the fixture token and the seeded concealed report
  // are part of the fixture set, not part of a test's leftovers.
  const seeded = new Map([['civiclens-mock-tracking-token-do-not-use', ['iss-concealed-1']]]);
  state.trackedTokens = seeded;
}
