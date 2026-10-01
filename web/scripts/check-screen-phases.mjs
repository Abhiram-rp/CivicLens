#!/usr/bin/env node
// Guards the claim in shared/not-yet.ts that each placeholder's `operations` are
// "the contract surface this screen will call" and its `phase` is "the SPEC 15 phase
// this screen belongs to".
//
// Both claims were false for nine screens, and neither could be caught by the
// compiler:
//
//   a. Phantom operations. admin/categories-page.ts listed `deleteCategory` and
//      admin/departments-page.ts listed `deleteDepartment`. Neither exists - the
//      contract's only DELETE is `deleteComment`, because categories and
//      departments are retired via `active: false` and never deleted (SPEC.md 367).
//      These were strings in a `ReadonlyArray<string>`, so they type-checked. Anyone
//      building the screen from the placeholder would have gone looking for an
//      operation the API can never serve.
//
//   b. Role mismatch. manager/analytics-page.ts listed `exportIssues`, which the
//      contract restricts to `x-required-roles: [ADMIN]`, on a route guarded by
//      STAFF_ROLES. The screen described would 403 on its own data.
//
//   c. Phase drift. `analytics` was labelled P1 but is P4 ("Transparency and
//      Analytics"); `officer/resolve-page` was labelled P2 but is P1 ("resolution
//      report"), and resolution is the centre of the P1 ship gate. Seven more
//      screens carried a P1 label for subject matter SPEC.md 547 and PLAN.md 174
//      explicitly place in P2. These labels are the only prioritisation signal a
//      reader has for 27 unbuilt screens.
//
// The expected phase per screen is declared in EXPECTED_PHASES below rather than
// parsed out of SPEC.md §15. That table is prose in a spec, not data; parsing it
// would mean reading a markdown table with a regex and calling the result
// authoritative. Keeping the expectation here means a reviewer can check one screen
// against one spec line and see the disagreement, which is the whole point.
//
// Text-based like check-generated-api.mjs: no YAML dependency, no network.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(webRoot, '..');
const contractPath = join(repoRoot, 'api', 'openapi', 'civiclens-v1.yaml');

const problems = [];
const note = (m) => console.log(`  ${m}`);

/**
 * Screen -> the SPEC 15 phase it belongs to, with the line that says so.
 *
 * Sourced from docs/SPEC.md §15 (lines 544-550), cross-checked against PLAN.md §6.
 */
const EXPECTED_PHASES = {
  // P1 - "Report and Track"
  'auth/sign-in-page': ['P1', 'SPEC.md:546 Auth'],
  'home/home-page': ['P1', 'SPEC.md:546'],
  'issues/report-issue-page': ['P1', 'SPEC.md:546 issue create'],
  'issues/my-reports-page': ['P1', 'SPEC.md:546 my-reports + timeline'],
  'issues/public-issue-page': ['P1', 'SPEC.md:546 public shareable page'],
  'issues/public-issue-detail-page': ['P1', 'SPEC.md:546 public shareable page'],
  'tracked/tracked-list-page': ['P1', 'SPEC.md:546 /tracked/**'],
  'tracked/tracked-detail-page': ['P1', 'SPEC.md:546 /tracked/**'],
  'contact/contact-verify-page': ['P1', 'SPEC.md:546 /contact/**'],
  'contact/contact-decision-page': ['P1', 'SPEC.md:546 /contact/**'],
  'manager/queue-page': ['P1', 'SPEC.md:546 staff list/detail/transition'],
  'officer/resolve-page': ['P1', 'SPEC.md:546 resolution report'],
  'errors/not-found-page': ['P1', 'scaffold hygiene, not a phase deliverable'],
  'errors/not-authorised-page': ['P1', 'scaffold hygiene, not a phase deliverable'],
  'notifications/notifications-page': ['P1', 'SPEC.md:546'],

  // P2 - "Triage and Workflow"
  'admin/users-page': ['P2', 'SPEC.md:547 departments + routing'],
  'admin/departments-page': ['P2', 'SPEC.md:547 Departments + routing; PLAN.md:174'],
  'admin/categories-page': ['P2', 'SPEC.md:547 category_proposals promotion; PLAN.md:174'],
  'admin/sla-page': ['P2', 'SPEC.md:547 SLA policies; PLAN.md:174 out of scope P1'],
  'admin/audit-logs-page': ['P2', 'SPEC.md:547 audit log'],
  'manager/assignment-page': ['P2', 'SPEC.md:547 assignment; PLAN.md:174'],
  'manager/sla-monitor-page': ['P2', 'SPEC.md:547 SLA overdue job; PLAN.md:174'],
  'manager/awaiting-confirmation-page': ['P2', 'SPEC.md:547 confirmations'],
  'manager/category-proposals-page': ['P2', 'SPEC.md:547 promotion flow; PLAN.md:174'],
  'manager/duplicate-review-page': ['P2', 'SPEC.md:453 rule-based duplicate flagging'],
  'officer/assigned-page': ['P2', 'SPEC.md:78 the officer split activates in P2'],

  // P4 - "Transparency and Analytics"
  'manager/analytics-page': ['P4', 'SPEC.md:549 CSV export, rollups, dashboards'],
};

const contract = readFileSync(contractPath, 'utf8');
const operationIds = new Set([...contract.matchAll(/^\s+operationId:\s*(\S+)/gm)].map((m) => m[1]));

// The roles each operation requires, so a screen cannot claim an operation its own
// route guard would refuse.
const opRoles = new Map();
{
  const lines = contract.split('\n');
  const indentOf = (line) => line.length - line.trimStart().length;
  let currentOp = null;
  let currentOpIndent = 0;
  for (const line of lines) {
    const op = /^(\s*)operationId:\s*(\S+)\s*$/.exec(line);
    if (op) {
      currentOp = op[2];
      currentOpIndent = indentOf(op[1]);
      continue;
    }
    if (currentOp === null) continue;
    if (/^\s*\S/.test(line) && indentOf(line) < currentOpIndent) {
      currentOp = null;
      continue;
    }
    const roles = /^\s*x-required-roles:\s*\[(.*)\]\s*$/.exec(line);
    if (roles) {
      opRoles.set(
        currentOp,
        roles[1]
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean),
      );
    }
  }
}

const featuresDir = join(webRoot, 'src', 'app', 'features');
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });

const screens = [];
for (const file of walk(featuresDir)) {
  if (!file.endsWith('.ts') || file.endsWith('.spec.ts')) continue;
  const src = readFileSync(file, 'utf8');
  if (!src.includes('NotYet')) continue; // a real screen, nothing to check here
  const key = relative(featuresDir, file).replace(/\\/g, '/').replace(/\.ts$/, '');
  screens.push({ key, src, file: relative(webRoot, file).replace(/\\/g, '/') });
}

note(`contract declares ${operationIds.size} operations; ${screens.length} placeholder screens checked`);

for (const { key, src, file } of screens) {
  const expected = EXPECTED_PHASES[key];
  if (!expected) {
    problems.push(`${file}: not listed in EXPECTED_PHASES - add it, or the screen is unclassified`);
    continue;
  }

  // --- (c) phase ------------------------------------------------------------
  const declared = /\[phase\]="'([^']+)'"/.exec(src);
  if (!declared) {
    problems.push(`${file}: no [phase] binding`);
  } else if (declared[1] !== expected[0]) {
    problems.push(
      `${file}: labelled ${declared[1]}, but ${expected[1]} puts it in ${expected[0]}`,
    );
  }

  // --- (a) phantom operations ----------------------------------------------
  const ops = /operations(?:: ReadonlyArray<string>)? = \[([^\]]*)\]/.exec(src);
  if (!ops) continue;
  const listed = [...ops[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const op of listed) {
    if (!operationIds.has(op)) {
      problems.push(`${file}: claims operation "${op}", which the contract does not declare`);
    }
  }

  // --- (b) role mismatch ----------------------------------------------------
  // A screen under a staff route cannot claim an admin-only operation. Checked
  // from the directory name, which is the same signal the route guard uses:
  // `features/admin/**` is ADMIN_ROLES and `features/manager/**` /
  // `features/officer/**` are STAFF_ROLES in app.routes.ts.
  const area = key.split('/')[0];
  const reachable = area === 'admin' ? ['ADMIN'] : area === 'home' ? null : ['CITIZEN', 'FIELD_OFFICER', 'DEPARTMENT_MANAGER', 'ADMIN'];
  if (!reachable) continue;
  for (const op of listed) {
    const required = opRoles.get(op);
    if (!required || required.includes('CITIZEN')) continue;
    const blocked = required.filter((r) => !reachable.includes(r));
    if (blocked.length) {
      problems.push(
        `${file}: claims "${op}", which needs ${blocked.join('/')} - this screen's route admits only ${reachable.join('/')}`,
      );
    }
  }
}

// Every expected screen should exist, or the table has gone stale.
for (const key of Object.keys(EXPECTED_PHASES)) {
  if (!screens.some((s) => s.key === key)) {
    problems.push(`EXPECTED_PHASES lists ${key}, which is no longer a placeholder screen`);
  }
}

console.log('');
if (problems.length) {
  console.error(`  ${problems.length} problem(s):`);
  for (const p of problems) console.error(`    - ${p}`);
  console.error('\n  Fix: correct the screen, or correct EXPECTED_PHASES if the spec moved.');
  process.exit(1);
}
console.log('  OK - every placeholder names real operations and the right phase.');
