import { http, HttpResponse } from 'msw';
import type { Category, Department, PublicIssue } from '../../app/api/generated/types.gen';
import { API, notFound, rejectUnexpectedBearer } from '../http';
import { asPublicIssue } from '../projections';
import { state } from '../store';

/**
 * `/public/**` and `/reference/**`: the two trees a signed-out visitor uses.
 *
 * ## The credential rules are opposite, and that is the point
 *
 * `/public/issues/{publicCode}` carries `security: []` in the contract, so a bearer
 * arriving here is a bug in `session-policy.ts` and is refused as a malformed
 * request - 400, not 403, because no role is allowed on this endpoint and a 403
 * would read as "your role is not permitted".
 *
 * `/reference/**` carries the *global* bearer: a signed-in caller is expected to
 * send one, and an anonymous one is refused with 401. An earlier draft of this mock
 * rejected a bearer here "to be safe", which 403'd every legitimate request - and a
 * mock that disagrees with the contract is worse than no mock, because it teaches
 * the UI to work around a rule that does not exist.
 */

/** `GET /public/issues/{publicCode}`. */
function publicIssue(request: Request, publicCode: string | readonly string[]): Response {
  const path = new URL(request.url).pathname;
  const unexpected = rejectUnexpectedBearer(request);
  if (unexpected) {
    return unexpected;
  }
  const code = typeof publicCode === 'string' ? publicCode : '';
  const issue = state.issues.find((candidate) => candidate.publicCode === code);
  // One 404 for "no such code" and for a code that exists but is not shareable. The
  // public tree is `PublicIssue`, whose allowlist has no reporter field at all, so
  // concealment is enforced by the shape rather than by a field being nulled.
  return issue ? HttpResponse.json(asPublicIssue(issue) satisfies PublicIssue) : notFound(path);
}

/**
 * `GET /reference/categories`.
 *
 * **Active only.** `Category.active: false` means retired: "absent from the report
 * form, unselectable for new issues". Filtering here rather than returning everything
 * is what lets the report form's category picker be written against the reference
 * endpoint instead of a second call to the admin one - and, more importantly, it is
 * what stops a retired category appearing as a choice that the server will reject.
 */
function referenceCategories(request: Request): Response {
  const unexpected = rejectUnexpectedBearer(request);
  if (unexpected) {
    return unexpected;
  }
  const active = state.categories.filter((category) => category.active);
  // Subcategories are filtered with their parent. A retired parent's children are
  // not offered either, because a subcategory with no visible parent cannot be
  // labelled in a picker - the UI would render an orphan.
  const shaped: Category[] = active.map((category) => ({
    id: category.id,
    name: category.name,
    code: category.code,
    parentCategoryId: category.parentCategoryId,
    defaultDepartmentId: category.defaultDepartmentId,
    active: category.active,
    subcategories: category.subcategories.filter((child) => child.active).map((child) => ({
      id: child.id,
      name: child.name,
      code: child.code,
      parentCategoryId: child.parentCategoryId,
      defaultDepartmentId: child.defaultDepartmentId,
      active: child.active,
      subcategories: [],
    })),
  }));
  return HttpResponse.json(shaped);
}

/**
 * `GET /reference/departments`.
 *
 * Active only, and **without `staffCount`**. The contract is explicit that
 * `staffCount` is "present on the admin endpoint only, never on the reference one",
 * because headcount is staff information and a signed-in citizen picking a
 * department does not need it. Dropping it here is a one-field omission, so it is
 * built field by field rather than spread.
 */
function referenceDepartments(request: Request): Response {
  const unexpected = rejectUnexpectedBearer(request);
  if (unexpected) {
    return unexpected;
  }
  const shaped: Department[] = state.departments
    .filter((department) => department.active)
    .map((department) => ({
      id: department.id,
      name: department.name,
      code: department.code,
      description: department.description,
      active: department.active,
    }));
  return HttpResponse.json(shaped);
}

export const publicHandlers = [
  http.get(`${API}/public/issues/:publicCode`, ({ request, params }) => publicIssue(request, params['publicCode']!)),
];

export const referenceHandlers = [
  http.get(`${API}/reference/categories`, ({ request }) => referenceCategories(request)),
  http.get(`${API}/reference/departments`, ({ request }) => referenceDepartments(request)),
];
