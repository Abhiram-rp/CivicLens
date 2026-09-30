#!/usr/bin/env node
// Guards the "contract-first" claim in SPEC.md 3 and REQUIREMENTS.md: the
// Angular client is generated from api/openapi/civiclens-v1.yaml, so a contract
// change that nobody regenerated must fail CI rather than sit in the tree.
//
// Two independent checks, because they fail differently:
//
//   1. Coverage   - every operationId in the contract has Data/Errors/Responses
//                   in the generated types. Catches "the contract grew and
//                   nobody regenerated".
//   2. Freshness  - regenerate into a temp directory and compare. Catches
//                   "someone hand-edited a generated file", which a comment
//                   asking them not to cannot prevent.
//
// Text-based like check-rate-limit-pairing.mjs: no YAML dependency, no network,
// so it can run as a pre-commit step.

import { readFileSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(webRoot, '..');
const contractPath = join(repoRoot, 'api', 'openapi', 'civiclens-v1.yaml');
const generatedDir = join(webRoot, 'src', 'app', 'api', 'generated');

const problems = [];
const note = (m) => console.log(`  ${m}`);

/**
 * Depth-first search for a declaration, returning the file it was found in.
 *
 * Skips `api/generated`, which is regenerated wholesale and must never be
 * searched for hand-written constants - a match there would mean the file was
 * edited by hand, which the freshness check already reports.
 */
function findDeclaration(dir, pattern) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'generated') {
        continue;
      }
      const found = findDeclaration(full, pattern);
      if (found) {
        return found;
      }
      continue;
    }
    if (!entry.name.endsWith('.ts')) {
      continue;
    }
    const match = pattern.exec(readFileSync(full, 'utf8'));
    if (match) {
      return { value: match[1], file: relative(webRoot, full) };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. Coverage
const contract = readFileSync(contractPath, 'utf8');
const operationIds = [...contract.matchAll(/^\s+operationId:\s*(\S+)/gm)].map((m) => m[1]);

const typesFile = join(generatedDir, 'types.gen.ts');
if (!readdirSync(generatedDir).includes('types.gen.ts')) {
  console.error(`  Generated client not found at ${generatedDir}. Run: npm run gen:api`);
  process.exit(1);
}
const types = readFileSync(typesFile, 'utf8');

note(`contract declares ${operationIds.length} operations`);

// The contract's operationIds are camelCase (`verifyContact`); the generator
// PascalCases them into type names (`VerifyContactData`). Case is normalised
// before comparison, because a case-sensitive match reports every operation as
// missing - which is a check that looks busy and is silently broken.
const norm = (s) => s.toLowerCase();

const missing = operationIds.filter(
  (id) => !new RegExp(`\\b${id}(data|errors|responses)\\b`, 'i').test(types),
);
if (missing.length) {
  for (const id of missing) problems.push(`contract operation "${id}" has no generated type - regenerate`);
}

// A generated type with no operation behind it means the client is stale in the
// other direction: an operation was renamed or removed and the old output is
// still checked in.
const generatedNames = new Set(
  [...types.matchAll(/^export type (\w+?)(?:Data|Errors|Responses)\s*=/gm)].map((m) =>
    norm(m[1]),
  ),
);
const orphaned = [...generatedNames].filter((n) => !operationIds.some((id) => norm(id) === n));
if (orphaned.length) {
  for (const n of orphaned) problems.push(`generated type "${n}*" has no operation in the contract - regenerate`);
}
const covered = operationIds.filter((id) => generatedNames.has(norm(id))).length;
note(`generated client covers ${covered} of ${operationIds.length} operations`);

// ---------------------------------------------------------------------------
// 2. Freshness: regenerate to a temp dir and diff.
const tmp = mkdtempSync(join(tmpdir(), 'civiclens-api-'));
try {
  // Invoked through node against the package's own bin entry rather than via
  // npx. Two reasons, both learned the hard way on Windows: Node refuses to
  // spawn a .cmd shim without a shell, and going through a shell means a temp
  // path containing a space silently splits into two arguments. execPath plus a
  // resolved bin path has neither problem.
  const pkg = JSON.parse(
    readFileSync(join(webRoot, 'node_modules', '@hey-api', 'openapi-ts', 'package.json'), 'utf8'),
  );
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0];
  const bin = join(webRoot, 'node_modules', '@hey-api', 'openapi-ts', binRel);

  // Note `-f` is the config file. `-c` is `--client` (the HTTP client to
  // generate), and passing the config path there makes the tool accept the flag
  // and then quietly write nothing - which reads as "the tree is stale".
  execFileSync(process.execPath, [bin, '-f', 'openapi-ts.config.json', '-o', tmp], {
    cwd: webRoot,
    stdio: 'pipe',
    env: { ...process.env, CI: '1' },
  });

  const walk = (dir) =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });

  // `root` is a parameter, not captured. Slicing both sides by the temp
  // directory's length reports 100% drift - turning the committed tree's
  // "core/auth.gen.ts" into a meaningless "en.ts" - while the files are in fact
  // byte-identical. A drift check that is always red trains people to ignore it.
  const rel = (root, p) => p.slice(root.length + 1).replace(/\\/g, '/');
  const read = (root) => new Map(walk(root).map((p) => [rel(root, p), readFileSync(p, 'utf8')]));

  const fresh = read(tmp);
  const committed = read(generatedDir);

  const allPaths = new Set([...fresh.keys(), ...committed.keys()]);
  let differs = 0;
  for (const p of [...allPaths].sort()) {
    if (fresh.get(p) !== committed.get(p)) {
      differs++;
      problems.push(
        `generated file is stale or hand-edited: ${p}${fresh.has(p) ? '' : ' (only in the tree)'}${committed.has(p) ? '' : ' (only in the contract)'}`,
      );
    }
  }
  note(differs === 0 ? 'checked-in output matches a fresh generation' : `${differs} file(s) differ from a fresh generation`);
} catch (err) {
  // A generation failure is itself worth failing on, but say why: a broken
  // contract should not be reported as "the client is stale".
  console.error('\n  regeneration failed:\n' + String(err.stdout ?? err.message).slice(0, 800));
  process.exit(1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 3. The hand-written API base URL must match the contract's first `servers`
//    entry, and the generated client's baked-in baseUrl must match too.
//
//    Three copies of the same URL is the hazard, so this asserts all three at
//    once. A mismatch sends traffic to the wrong host and surfaces as a bare
//    404 with no application error to read.
// ---------------------------------------------------------------------------
{
  const serverMatch = /^servers:\s*\n\s*-\s*url:\s*(\S+)\s*$/m.exec(contract);
  if (!serverMatch) {
    problems.push('could not find a `servers` block in the contract');
  } else {
    const contractBase = serverMatch[1];

    // The declaration is located by scanning `src/app` rather than by naming a
    // file. The constant was originally in `core/api/api-client.config.ts` and
    // had to move to `core/api/api-base-url.ts`, because both the interceptors
    // and `session-policy.ts` need it and importing it from the client config
    // would close an import cycle through those same interceptors. With the path
    // hardcoded, that legitimate move failed this check - correctly, since the
    // check's job is to notice the base URL changing, but for the wrong reason.
    //
    // Scanning the source tree means a future move is a non-event, and a
    // *changed* URL is still caught: that is a different string, not a different
    // file.
    const appDir = join(webRoot, 'src', 'app');
    const declaration = findDeclaration(appDir, /export const API_BASE_URL = '([^']+)'/);
    const generated = /baseUrl:\s*'([^']+)'/.exec(
      readFileSync(join(generatedDir, 'client.gen.ts'), 'utf8'),
    );

    if (!declaration) {
      problems.push('API_BASE_URL is not declared anywhere under src/app');
    } else if (declaration.value !== contractBase) {
      problems.push(
        `API_BASE_URL is ${declaration.value} (${declaration.file}) but the contract says ${contractBase}`,
      );
    }
    if (generated && generated[1] !== contractBase) {
      problems.push(`generated client baseUrl is ${generated[1]} but the contract says ${contractBase}`);
    }
    note(`api base url agrees across contract, constant and generated client: ${contractBase}`);
  }
}

// ---------------------------------------------------------------------------
// 5. Authorisation drift: `x-required-roles` and `security` must tell the same
//    story, and a status code must actually be inside `responses`.
//
//    SPEC.md 7.2a calls this "the `x-required-roles` drift assertion" and leans
//    on it being meaningful. It did not exist, which is how the following
//    shipped: `GET /reference/categories` declared
//    `x-required-roles: [CITIZEN, ...]` and no `security: []`, so it required a
//    session - while `POST /issues` is public precisely so a reporter with no
//    account can file a report. The report form was therefore unusable by the
//    concealed reporter the product is written for, and the mock served the
//    endpoint unauthenticated, so it worked in development and would have 401'd
//    in production. Nothing in the test suite or in this script noticed.
//
//    Two independent failure shapes, so they are checked separately:
//
//      a. roles/security disagreement. A non-empty role list with no
//         `security: []` means "authenticated and role-checked"; an empty list
//         with `security: []` means "open to anyone". One saying the first and
//         the generated client saying the other is the bug above.
//
//      b. an orphaned status code. YAML indentation is the only thing separating
//         a response from a stray property, and a block indented two spaces too
//         far silently demotes `'401':` from a documented response to an extra
//         key on the operation object - so the error disappears from the
//         generated client with no error anywhere. That happened to both
//         `/reference/*` operations.
//
//    Text-based like the rest of this file: no YAML dependency, no network.
// ---------------------------------------------------------------------------

// (a) roles vs security, per operation, using the operation's own indent so a
// nested block cannot be misattributed to its parent.
{
  const lines = contract.split('\n');
  const indentOf = (line) => line.length - line.trimStart().length;

  const opSecurity = new Map(); // operationId -> true if it declares security: []
  const opRoles = new Map(); // operationId -> true if it declares a non-empty role list

  let currentOp = null;
  let currentOpIndent = 0;

  for (const line of lines) {
    const op = /^(\s*)operationId:\s*(\S+)\s*$/.exec(line);
    if (op) {
      currentOp = op[2];
      currentOpIndent = indentOf(op[1]);
      continue;
    }
    if (currentOp === null || currentOpIndent === 0) continue;
    // A line less indented than the operation's own keys belongs to the path or
    // the method, not to this operation.
    if (/^\s*\S/.test(line) && indentOf(line) < currentOpIndent) {
      currentOp = null;
      continue;
    }
    if (/^\s*security:\s*\[\]\s*$/.test(line)) {
      opSecurity.set(currentOp, true);
    }
    // `.*` not `.+`: an empty `x-required-roles: []` is the case that most needs
    // checking, and `.+` requires at least one character inside the brackets so
    // it silently failed to match - the operation then fell out of both maps and
    // the check reported "all agree" while examining 55 of 56 operations.
    const roles = /^\s*x-required-roles:\s*\[(.*)\]\s*$/.exec(line);
    if (roles) {
      opRoles.set(currentOp, roles[1].trim().length > 0);
    }
  }

  const disagreements = [];
  // Iterate the *union* of both maps, not just the public ones. An earlier
  // version looped over `opSecurity` alone, which meant an operation that
  // required a role and simply omitted `security: []` - precisely the bug this
  // check was added for - was never examined at all and the check reported "all
  // agree". Found by reintroducing the original bug and watching it pass.
  const allOps = new Set([...opSecurity.keys(), ...opRoles.keys()]);
  for (const op of allOps) {
    const isPublic = opSecurity.get(op) === true;
    const needsRole = opRoles.get(op) === true;
    const declaresRoles = opRoles.has(op);
    if (isPublic && needsRole) {
      disagreements.push(`${op}: declares security: [] but also requires a role`);
    }
    if (!isPublic && declaresRoles && !needsRole) {
      disagreements.push(`${op}: requires no role but does not declare security: []`);
    }
  }
  for (const d of disagreements) {
    problems.push(`authorisation drift - ${d}`);
  }
  note(
    `authorisation: ${allOps.size} operations checked for roles/security agreement` +
      (disagreements.length ? '' : ' (all agree)'),
  );
}

// (b) status codes must be a direct child of `responses:`.
//
// Two malformation shapes, and an earlier version of this check caught only the
// first, so it reported "all status codes nested correctly" while the response
// was in fact unreachable. Both were found by mutating the contract and watching
// the check pass, which is the only way to tell a guard that works from one that
// merely runs:
//
//   - same indent as `responses:`: a stray key on the *operation* object. This
//     is the original bug - YAML indentation is the only thing separating a
//     documented response from a property, and the error silently vanishes from
//     the generated client.
//   - deeper than one level: the status code has been nested inside another
//     status code's body, e.g. `'401'` under `'200'`'s `content:`. Also silent.
{
  const lines = contract.split('\n');
  const indentOf = (line) => line.length - line.trimStart().length;
  const orphans = [];
  let responsesIndent = null;
  let where = '';

  for (const line of lines) {
    if (/^paths:\s*$/.test(line)) continue;
    const op = /^\s*operationId:\s*(\S+)\s*$/.exec(line);
    if (op) {
      where = op[1];
      responsesIndent = null;
    }
    const res = /^(\s*)responses:\s*$/.exec(line);
    if (res) {
      responsesIndent = indentOf(res[1]);
      continue;
    }
    const code = /^(\s*)'(\d{3}|[45]XX)':/.exec(line);
    if (code && responsesIndent !== null) {
      const at = indentOf(code[1]);
      if (at === responsesIndent) {
        orphans.push(`${where}: '${code[2]}' sits beside responses:, not inside it`);
      } else if (at > responsesIndent + 2) {
        orphans.push(
          `${where}: '${code[2]}' is nested ${at - responsesIndent - 2} level(s) too deep inside responses:`,
        );
      }
    }
  }
  for (const o of orphans) {
    problems.push(`orphaned response - ${o}`);
  }
  note(`response blocks: ${orphans.length ? `${orphans.length} malformed` : 'all status codes correctly nested'}`);
}

// ---------------------------------------------------------------------------
// 6. Report
console.log('');
if (problems.length) {
  console.error(`  ${problems.length} problem(s):`);
  for (const p of problems) console.error(`    - ${p}`);
  console.error('\n  Fix: npm run gen:api   (never edit src/app/api/generated by hand)');
  process.exit(1);
}
console.log('  OK - the client matches the contract.');
