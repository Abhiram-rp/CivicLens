#!/usr/bin/env node
// Verifies the rate-limit invariant declared in
// api/openapi/civiclens-v1.yaml under `components.headers`:
//
//   budget headers appear on an operation IFF SPEC.md 7.5 gives it a rate,
//   in BOTH directions - no headers without a limit, no limit without headers.
//
// It drifted once already: GET /issues advertised a budget it had no limit
// for, three /tracked operations never declared a 429, and the hand-inlined
// login 429 lost its Retry-After. Schema lint cannot catch any of that,
// because none of it is a schema error.
//
// Text-based by design: it needs no YAML dependency and no network, so it can
// run as a pre-commit or CI step. It tracks `operationId:` blocks and records
// whether each declares budget headers and whether it declares a 429.
// Deliberately conservative: an operation that $ref's `RateLimited` counts as
// having a 429, and a 429 that inherits headers from that component counts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = join(root, 'api', 'openapi', 'civiclens-v1.yaml');
const specPath = join(root, 'docs', 'SPEC.md');

const contract = readFileSync(contractPath, 'utf8');
const spec = readFileSync(specPath, 'utf8');

// ---------------------------------------------------------------------------
// 1. The limited set, parsed out of SPEC.md 7.5's table ONLY. Scoping matters:
//    other sections carry tables too (the 3.1 disclosure table, the state
//    machine), and a naive scan of every `|` row picks up values like
//    `SHARE_DETAILS` and `AI_ANALYZING` as if they were endpoints.
const specLines = spec.split('\n');
const start = specLines.findIndex((l) => /^#{2,4}\s+7\.5\b/.test(l));
if (start === -1) {
  console.error('Could not find the "### 7.5" heading in docs/SPEC.md');
  process.exit(1);
}

const table = [];
for (let i = start; i < specLines.length; i++) {
  const line = specLines[i];
  if (i > start && /^#{1,4}\s/.test(line)) break; // next section: table is over
  if (/^\|\s*`/.test(line)) table.push(line.split('|')[1].trim().replace(/`/g, ''));
}

const limited = new Set();
for (const row of table) {
  if (!row || /^(Endpoint|Path|Operation)$/i.test(row)) continue;
  if (row === '/tracked/**' || row.startsWith('/tracked/')) limited.add('/tracked/**');
  else if (/\//.test(row) || /AI/.test(row)) limited.add(row);
}

// ---------------------------------------------------------------------------
// 2. Walk the contract operation by operation, attributing each budget header
//    to the response it actually sits under. Status-code keys are at
//    `operationId` indent + 2 and header keys at + 6, so a header is only
//    credited to a response if it is genuinely nested inside that range.
//    Without this, headers on a 429 make the success look covered when it is
//    not - which is exactly the hole it is meant to close.
const lines = contract.split('\n');
const ops = [];
let cur = null;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  const opMatch = line.match(/^(\s*)operationId: (\S+)/);
  if (opMatch) {
    cur = { id: opMatch[2], indent: opMatch[1].length, start: i + 1, responses: {} };
    ops.push(cur);
    continue;
  }
  if (!cur) continue;

  // A new path or component section ends the current operation block.
  if (/^  (\/[^:]*|[\w#-]+):\s*$/.test(line) || /^  (schemas|responses|parameters|headers):\s*$/.test(line)) {
    cur = null;
    continue;
  }
  // A sibling HTTP method ends it too.
  const verb = line.match(/^(\s*)(get|post|put|patch|delete):\s*$/);
  if (verb && verb[1].length === cur.indent - 2) {
    cur = null;
    continue;
  }

  // A status-code key opens (or closes) a response range.
  const code = /^(\s*)'(\d{3})':/.exec(line);
  if (code && code[1].length === cur.indent + 2) {
    cur.current = code[2];
    cur.responses[cur.current] = { budget: false, retryAfter: false };
    // A 429 that $refs the shared component inherits its headers; record that
    // here, on the status line itself, because this line is consumed here and
    // never reaches the header checks below.
    if (/\$ref:\s*'#\/components\/responses\/RateLimited'/.test(line)) {
      cur.responses[cur.current].refd = true;
    }
    continue;
  }
  if (!cur.current) continue;

  if (/X-RateLimit-Limit/.test(line)) cur.responses[cur.current].budget = true;
  if (/Retry-After/.test(line)) cur.responses[cur.current].retryAfter = true;
}

// ---------------------------------------------------------------------------
// 2b. Effective headers of the shared RateLimited response, for the $ref case.
const rateLimitedSrc = contract.split('\n');
const rlStart = rateLimitedSrc.findIndex((l) => /^    RateLimited:\s*$/.test(l));
const shared = { budget: false, retryAfter: false };
if (rlStart !== -1) {
  for (let i = rlStart + 1; i < rateLimitedSrc.length; i++) {
    const line = rateLimitedSrc[i];
    if (/^    \S/.test(line)) break; // next sibling response
    if (/X-RateLimit-Limit/.test(line)) shared.budget = true;
    if (/Retry-After/.test(line)) shared.retryAfter = true;
  }
}
for (const op of ops) {
  const r = op.responses['429'];
  if (!r) continue;
  if (r.refd) {
    r.retryAfter = r.retryAfter || shared.retryAfter;
    r.budget = r.budget || shared.budget;
  }
}

// ---------------------------------------------------------------------------
// 3. Map each operation to the SPEC row that governs it, and compare.
function governs(op) {
  if (op.id.startsWith('listTracked') || op.id.startsWith('getTracked') ||
      op.id.startsWith('updateTracked') || op.id.startsWith('addTracked') ||
      op.id.startsWith('confirmTracked') || op.id.startsWith('reopenTracked') ||
      op.id.startsWith('revealTracked')) {
    return '/tracked/**';
  }
  // The contact surface is split into two SPEC rows rather than one
  // `/contact/**` wildcard, because the two limits differ: a verification
  // token proves nothing until it succeeds, so it is the more brute-forceable
  // of the two, and a decision is worth throttling harder than a read.
  if (op.id === 'verifyContact') return 'POST /contact/verify';
  if (op.id === 'submitContactDecision') return 'POST /contact/decision';
  if (op.id === 'createIssue') return 'POST /issues';
  if (op.id === 'addComment') return 'POST /issues/{id}/comments';
  if (op.id === 'login') return 'POST /auth/login';
  if (op.id === 'register') return 'POST /auth/register';
  if (op.id.startsWith('getPublic')) return 'GET /public/**';
  if (/[Aa]naly|[Rr]ank|[Ee]mbed|[Dd]etect|[Dd]edupe|[Pp]riority/.test(op.id)) {
    return 'AI-triggering paths';
  }
  return null;
}

const problems = [];
const rows = [];

for (const op of ops) {
  const rule = governs(op);
  if (rule === null || !limited.has(rule)) continue;

  const success = Object.entries(op.responses).find(([code]) => code !== '429' && code[0] === '2');
  const rate = op.responses['429'];

  const hasBudget = Boolean(success && success[1].budget);
  const has429 = Boolean(rate);

  rows.push({ op: op.id, rule, hasBudget, has429, retry: Boolean(rate && rate.retryAfter) });

  if (!hasBudget) {
    problems.push(`${op.id} (line ${op.start}): limited by SPEC 7.5 but its 2xx carries no X-RateLimit-* budget headers`);
  }
  if (!has429) {
    problems.push(`${op.id} (line ${op.start}): limited by SPEC 7.5 but declares no 429`);
  }
  if (has429 && rate && !rate.retryAfter) {
    problems.push(`${op.id} (line ${op.start}): 429 is missing Retry-After`);
  }
  // A rate-limited operation may not advertise headers on 2xx without a limit.
  for (const [code, r] of Object.entries(op.responses)) {
    if (r.budget && code !== '429' && rule === null) {
      problems.push(`${op.id} (line ${op.start}): 2xx advertises a budget but SPEC 7.5 gives it no rate`);
    }
  }
}

// Limited by SPEC but carrying no headers and no 429 at all.
for (const rule of limited) {
  const covered = rows.filter((r) => r.rule === rule);
  if (covered.length === 0) {
    problems.push(`SPEC 7.5 limits "${rule}" but no operation in the contract was matched to it`);
  } else if (covered.every((r) => !r.hasBudget && !r.has429)) {
    problems.push(`SPEC 7.5 limits "${rule}" but none of its operations declare headers or 429`);
  }
}

// ---------------------------------------------------------------------------
// 4. Report.
const w = Math.max(...rows.map((r) => r.op.length), 8);
console.log('Rate-limit pairing check (SPEC.md 7.5  <->  contract)\n');
for (const r of rows.sort((a, b) => a.op.localeCompare(b.op))) {
  const mark = r.hasBudget && r.has429 ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${r.op.padEnd(w)}  ${r.rule}`);
}
console.log(`\n  ${rows.length} rate-limited operations checked, ${limited.size} SPEC rules matched.`);

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nAll paired: every limited operation declares budget headers on success and a 429.');
