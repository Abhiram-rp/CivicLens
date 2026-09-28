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
// 4. Report
console.log('');
if (problems.length) {
  console.error(`  ${problems.length} problem(s):`);
  for (const p of problems) console.error(`    - ${p}`);
  console.error('\n  Fix: npm run gen:api   (never edit src/app/api/generated by hand)');
  process.exit(1);
}
console.log('  OK - the client matches the contract.');
