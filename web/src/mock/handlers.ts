import { adminHandlers } from './handlers/admin';
import { authHandlers } from './handlers/auth';
import { contactHandlers } from './handlers/contact';
import { dashboardHandlers } from './handlers/dashboard';
import { issueHandlers } from './handlers/issues';
import { notificationHandlers } from './handlers/notifications';
import { publicHandlers, referenceHandlers } from './handlers/public';
import { sessionHandlers } from './handlers/session';
import { trackedHandlers } from './handlers/tracked';

/**
 * The mock server's complete handler set: every operation in the contract, and
 * nothing else.
 *
 * ## Why this file is composition and nothing else
 *
 * It used to be a 756-line file containing the login handler, the create handler, a
 * second copy of the tracked-tree rules, the public and reference endpoints, and a
 * dashboard of hard-coded numbers. The `POST /issues` logic then moved into
 * `handlers/create-issue.ts`, and for a while **both** copies were registered.
 *
 * That is the failure this file exists to make impossible. MSW resolves a duplicated
 * route to whichever registration it saw first, silently: two handlers for one path
 * type-check, build, and pass every test that exercises only one of them - and then
 * the wrong one answers in the browser. Two of those routes were also genuinely
 * missing (`/status` and `/transition` were written as a factory nobody called),
 * which is the other half of the same problem: a single 800-line file cannot be
 * checked against the contract, so nothing checks it.
 *
 * So the rule is: **one module owns one operation, and this file lists them.** If a
 * new operation is added, it appears here or it does not exist. `check-generated-api.mjs`
 * enforces the other direction - that every path in the contract is claimed here.
 */

/**
 * Composition order.
 *
 * Meaningful in one respect only: more specific paths must come before the `:id`
 * patterns that would otherwise swallow them. MSW matches in registration order, so
 * `GET /issues/mine` has to precede `GET /issues/:issueId` or it resolves as an
 * issue whose id is literally "mine".
 *
 * `issueHandlers` already orders `mine` before `:issueId` internally, so the
 * grouping here is safe; the comment is kept because the constraint is invisible
 * until it breaks.
 */
export const handlers = [
  // No credential, or an unauthenticated caller.
  ...sessionHandlers,
  ...authHandlers,

  // The report lifecycle, by transport.
  ...issueHandlers,
  ...trackedHandlers,
  ...contactHandlers,

  // Staff surfaces.
  ...adminHandlers,
  ...dashboardHandlers,
  ...notificationHandlers,

  // Shared reference data and the public share page.
  ...publicHandlers,
  ...referenceHandlers,
];

export { ISSUE_LIMITS } from './handlers/create-issue';
