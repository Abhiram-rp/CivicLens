import { http, HttpResponse } from 'msw';
import type { Category, Department, PublicIssue } from '../../app/api/generated/types.gen';
import { API, notFound, rejectUnexpectedBearer } from '../http';
import { asPublicIssue } from '../projections';
import { state } from '../store';

/**
 * `/public/**` and `/reference/**`: the two trees a signed-out visitor uses, and both
 * of which the report form depends on before anyone has an account.
 *
 * ## Both carry `security: []`, so both refuse a bearer
 *
 * The contract marks `/public/issues/{publicCode}` and both `/reference/**` operations
 * `security: []` - no credential is required. An anonymous request is therefore the
 * legitimate one, and a bearer arriving at either is a bug in the caller's
 * `session-policy.ts`, refused as a malformed request.
 *
 * 400, not 403, because no role is permitted on these endpoints: a 403 would read as
 * "your role is not allowed here", which would send the UI looking for a different role
 * when the real fault is that it sent credentials at all.
 *
 * Note the earlier draft of this comment claimed the opposite - that `/reference/**`
 * took the global bearer and refused anonymous callers with 401 - and the handlers did
 * not match it either. The contract is the authority here: all three operations are
 * `security: []`, so a report form that loads categories before sign-in works, and one
 * that leaks a bearer into the request gets told so.
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
