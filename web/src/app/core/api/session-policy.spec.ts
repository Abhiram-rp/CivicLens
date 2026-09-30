import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SESSION_EXEMPT_PATHS, isSessionExempt } from './session-policy';
import { API_BASE_URL, apiPath } from './api-base-url';

/**
 * The bearer-withholding rule is a security control, so it is checked against
 * the contract rather than trusted.
 *
 * SPEC 7.2a rests on reporter identity being *structurally* absent from
 * `/tracked/**`: those operations declare `security: []` in the OpenAPI
 * document, and that marker is the document's way of saying "no session
 * credential belongs here". The generated client discards those markers - it
 * emits no `security` field at all - so the frontend re-establishes the rule
 * with a hand-written prefix list. A hand-written list is exactly the kind of
 * thing that rots, so this test fails if the contract gains an unauthenticated
 * operation the list does not cover.
 *
 * The contract is read as text, not parsed as YAML, to match
 * `scripts/check-rate-limit-pairing.mjs` and avoid adding a parser dependency
 * for one assertion.
 */

/**
 * The URL an interceptor actually sees.
 *
 * Every assertion in this file goes through this helper rather than passing a
 * bare path, and that is the whole point of the rewrite. The first version of
 * `isSessionExempt` segmented the raw `Request.url` pathname, and because the
 * base URL ends in `/api/v1` the first segment of every real request was `api`.
 * Nothing was ever exempt, so `authInterceptor` attached a session bearer to
 * `/auth/**`, `/tracked/**` and `/public/**` - exactly the leak the function
 * exists to prevent. Every test in the original file still passed, because every
 * one of them passed a bare `/auth/refresh`, and a bare path has no `api`
 * segment to trip over. Testing the string the production code is handed is the
 * only version of this test that means anything.
 */
const url = (path: string) => `${API_BASE_URL}${path}`;

const contractPath = join(
  dirname(fileURLToPath(import.meta.url)),
  // src/app/core/api -> src/app/core -> src/app -> src -> web -> repo root
  '..',
  '..',
  '..',
  '..',
  '..',
  'api',
  'openapi',
  'civiclens-v1.yaml',
);

interface UnauthenticatedOp {
  operationId: string;
  method: string;
  path: string;
}

/** Walks the paths block, pairing each `security: []` with its operation. */
function unauthenticatedOperations(): UnauthenticatedOp[] {
  const lines = readFileSync(contractPath, 'utf8').split('\n');
  const found: UnauthenticatedOp[] = [];

  let method = '';
  let path = '';
  let operationId = '';
  let inPaths = false;

  for (const line of lines) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (inPaths && /^components:\s*$/.test(line)) {
      break;
    }
    if (!inPaths) {
      continue;
    }

    const pathMatch = /^ {2}(\/\S*):\s*$/.exec(line);
    if (pathMatch) {
      path = pathMatch[1];
      continue;
    }

    const methodMatch = /^ {4}(get|post|put|delete|patch):\s*$/.exec(line);
    if (methodMatch) {
      method = methodMatch[1].toUpperCase();
      continue;
    }

    const opMatch = /^ {6}operationId:\s*(\S+)\s*$/.exec(line);
    if (opMatch) {
      operationId = opMatch[1];
      continue;
    }

    if (/^ {6}security:\s*\[\]\s*$/.test(line)) {
      found.push({ operationId, method, path });
    }
  }

  return found;
}

const ops = unauthenticatedOperations();

describe('apiPath', () => {
  it('strips the API base prefix from a real request URL', () => {
    // The regression test for the bug documented in `api-base-url.ts`. Without
    // the strip, the first path segment of every request is `api` and the
    // credential rules silently stop applying.
    expect(apiPath(`${API_BASE_URL}/auth/refresh`)).toBe('/auth/refresh');
    expect(apiPath(`${API_BASE_URL}/tracked/issues/iss-1`)).toBe('/tracked/issues/iss-1');
    expect(apiPath(`${API_BASE_URL}/issues`)).toBe('/issues');
  });

  it('handles the base URL itself, and a URL outside the API root', () => {
    expect(apiPath(API_BASE_URL)).toBe('/');
    // A URL on another origin is returned unchanged rather than mangled. Failing
    // to match an exempt tree is the safe direction to be wrong in: the request
    // gets a bearer it perhaps should not have, rather than losing one it needs.
    expect(apiPath('https://elsewhere.example.org/tracked/issues')).toBe('/tracked/issues');
  });
});

describe('session bearer policy vs the contract', () => {
  it('finds the operations the contract marks unauthenticated', () => {
    // Guards the parser above: if this reports zero, every assertion below
    // passes vacuously and the file would look like proof of something it never
    // checked.
    expect(ops.length).toBeGreaterThanOrEqual(15);
  });

  it('withholds the bearer from every operation the contract marks unauthenticated', () => {
    // `POST /issues` is the documented exception and is asserted separately
    // below. It is excluded here by name rather than by path so that adding a
    // second optional-auth endpoint later is a visible test change.
    const expectedOptional = new Set(['createIssue']);
    const unexpected = ops
      .filter((op) => !expectedOptional.has(op.operationId))
      .filter((op) => !isSessionExempt(url(op.path)));

    expect(
      unexpected.map((op) => `${op.method} ${op.path} (${op.operationId})`),
      'these operations declare security: [] but a session bearer would be sent',
    ).toEqual([]);
  });

  it('attaches the bearer for POST /issues, which is optional-auth', () => {
    // The server decides signed-in versus concealed by the header's *presence*,
    // so the frontend has to send the bearer when there is a session and omit it
    // otherwise. Never attaching it files a signed-in citizen's report as
    // concealed, which is a wrong and privacy-relevant outcome, not a cosmetic
    // one.
    expect(isSessionExempt(url('/issues'))).toBe(false);
  });

  it('withholds the bearer from every exempt tree, including nested paths', () => {
    for (const prefix of SESSION_EXEMPT_PATHS) {
      expect(isSessionExempt(url(prefix))).toBe(true);
      expect(isSessionExempt(url(`${prefix}/`))).toBe(true);
      expect(isSessionExempt(url(`${prefix}/some/deep/path`))).toBe(true);
    }
  });

  it('keeps the report form reachable by a reporter with no session', () => {
    // The regression this whole block exists to prevent. `POST /issues` is
    // public so a signed-out reporter can file a report, and the categories that
    // populate the same form are public too. They were briefly not: the contract
    // required a CITIZEN role on `/reference/categories`, which left the report
    // form unusable by the concealed reporter SPEC 3.1 is written for - and the
    // mock served the same endpoint unauthenticated, so the form worked in
    // development and would have 401'd in production.
    //
    // Asserted against the contract rather than as a literal, so the guarantee is
    // re-established if either side changes.
    const referenceOps = ops.filter((op) => op.path.startsWith('/reference/'));
    expect(referenceOps.length).toBeGreaterThan(0);
    for (const op of referenceOps) {
      expect(isSessionExempt(url(op.path)), `${op.operationId} must not require a session`).toBe(
        true,
      );
    }
  });

  it('only exempts prefixes the contract actually marks unauthenticated', () => {
    // The inverse of the check above, and the one that was missing. Without it an
    // over-broad prefix could be added to `SESSION_EXEMPT_PATHS` and no test would
    // object, because the forward check only asks about operations the contract
    // already marks public - it never asks whether an exempt prefix corresponds
    // to anything. The failure mode is a signed-in user being silently turned
    // anonymous on a surface that needed the bearer, which surfaces as a logout
    // with no error.
    const publicPrefixes = new Set(
      ops.map((op) => `/${op.path.replace(/^\//, '').split('/')[0]}`),
    );
    // `/issues` is public for `createIssue` but credential-bearing for the rest of
    // its tree, so it is deliberately not exempt and must be tolerated here.
    const unexemptableButPartlyPublic = new Set(['/issues']);

    const unjustified = SESSION_EXEMPT_PATHS.filter(
      (prefix) => !publicPrefixes.has(prefix) && !unexemptableButPartlyPublic.has(prefix),
    );

    expect(
      unjustified,
      'these prefixes are exempt from the bearer but the contract marks nothing under them public',
    ).toEqual([]);
  });

  it('keeps session surfaces out of the exempt list', () => {    // The negative direction matters as much as the positive: an over-broad
    // prefix silently breaks the citizen and staff areas, and the symptom is a
    // signed-in user mysteriously logged out.
    expect(isSessionExempt(url('/issues'))).toBe(false);
    expect(isSessionExempt(url('/issues/CIV-100482'))).toBe(false);
    expect(isSessionExempt(url('/notifications'))).toBe(false);
    expect(isSessionExempt(url('/dashboard'))).toBe(false);
    expect(isSessionExempt(url('/admin/users'))).toBe(false);
  });

  it('withholds the bearer from the auth endpoints themselves', () => {
    // `/auth` is in the exempt list, and `/auth/refresh` is the sharpest case:
    // it authenticates with the HttpOnly cookie, and a stale bearer sent
    // alongside it can only confuse the server's view of who is calling. If a
    // refresh is issued with an expired access token still attached, a naive
    // server would reject it and sign the user out mid-session.
    expect(isSessionExempt(url('/auth/refresh'))).toBe(true);
    expect(isSessionExempt(url('/auth/login'))).toBe(true);
    expect(isSessionExempt(url('/auth/register'))).toBe(true);
  });

  it('does not exempt a path that merely starts with an exempt string', () => {
    // `/tracker` is not `/tracked`. A prefix match on the raw string rather than
    // the path segment would exempt a surface nobody has reviewed.
    expect(isSessionExempt(url('/tracker/anything'))).toBe(false);
    expect(isSessionExempt(url('/publicity'))).toBe(false);
    expect(isSessionExempt(url('/authentication'))).toBe(false);
  });
});
