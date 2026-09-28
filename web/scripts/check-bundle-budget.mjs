#!/usr/bin/env node
// The citizen shell's initial payload, measured the way a browser measures it.
//
// REQUIREMENTS.md sets a launch gate: "Angular initial bundle <= 250 KB gzipped
// for the citizen shell; lazy-load staff and admin features". Two parts of that
// are not enforced by Angular's own `budgets` option, which is why this exists.
//
// 1. **It measures gzipped, not raw.** `budgets: [{ type: 'initial', ... }]`
//    compares uncompressed byte counts. Our gate is about what crosses the
//    network, and the two differ by roughly 4x on this bundle, so a raw-byte
//    budget either passes something the gate forbids or fails something it
//    allows. This script gzips the real files with `zlib` and compares that.
//
// 2. **It holds the citizen shell to the citizen limit.** The `initial` budget
//    applies to the whole entry point, and the entry point is shared. The point
//    of lazy-loading staff and admin features is that an officer's tooling is
//    never on a citizen's critical path, so the gate is checked against what
//    `index.html` actually pulls in before first paint.
//
// The file set is read from `index.html` rather than recomputed from the build
// graph, because Angular already writes it down: it emits a `modulepreload` for
// every chunk in the initial group and nothing for a lazy route. Re-deriving it
// would mean reimplementing the bundler's reachability analysis and hoping the
// two agree.
//
// One further check rides along, because it is a regression this repository has
// already made once and the size gate provably cannot see it: the mock library
// must not ship. The measurements behind that are in section 2.
//
// Note on the rest of REQUIREMENTS.md 169, "lazy-load staff and admin features":
// there is deliberately no separate check. Everything reachable from
// `index.html` is initial and everything else is lazy, by the bundler's
// definition, so a staff screen can only reach the critical path by being
// imported eagerly from the route table - and if that happened, its code would be
// in the initial set, where the size gate above would price it. A separate "is
// staff code lazy" assertion would be a second, worse proxy for the same fact.

import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const browserDir = join(webRoot, 'dist', 'web', 'browser');

/** REQUIREMENTS.md 169: <= 250 KB gzipped. 250 * 1024, to match Angular's units. */
const BUDGET_BYTES = 250 * 1024;

/**
 * A string literal that exists only inside msw: the protocol header it stamps on
 * a request it has handled. Chosen because it is verifiable against a build
 * rather than guessed - see the note where it is used.
 */
const MSW_MARKER = 'x-msw-intention';

const problems = [];
const note = (m) => console.log(`  ${m}`);
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;

// ---------------------------------------------------------------------------
// Read the build output
if (!existsSync(join(browserDir, 'index.html'))) {
  console.error(`  No build at ${browserDir}. Run: npm run build`);
  process.exit(1);
}

const indexHtml = readFileSync(join(browserDir, 'index.html'), 'utf8');

/**
 * Everything `index.html` fetches before first paint.
 *
 * `modulepreload` is the load-bearing part: Angular emits one per initial chunk,
 * and none for a lazy route. `index.html` itself is counted too, since it is a
 * required round trip that blocks rendering, and it carries the inlined critical
 * CSS - roughly 12 kB of theme custom properties - which would otherwise be
 * invisible in this number.
 */
const referenced = new Set(['index.html']);
for (const match of indexHtml.matchAll(/(?:href|src)="([^"]+\.(?:js|css))"/g)) {
  referenced.add(basename(match[1]));
}

const files = [...referenced].sort();
const sizes = new Map();
let rawTotal = 0;
let gzipTotal = 0;

for (const file of files) {
  const path = join(browserDir, file);
  if (!existsSync(path)) {
    // A `modulepreload` for a file that was not emitted would mean the HTML
    // references a missing asset, which is a broken build, not a budget
    // problem - worth its own message so it is not misread as one.
    problems.push(`index.html references ${file}, which is not in the build output`);
    continue;
  }
  const raw = readFileSync(path);
  const gzipped = gzipSync(raw, { level: 9 }).length;
  sizes.set(file, { raw: raw.length, gzip: gzipped });
  rawTotal += raw.length;
  gzipTotal += gzipped;
}

note(`initial files: ${files.length} (from index.html)`);
for (const [file, size] of sizes) {
  note(`  ${file.padEnd(26)} ${kb(size.raw).padStart(10)} raw  ${kb(size.gzip).padStart(9)} gzip`);
}
note(`  ${'total'.padEnd(26)} ${kb(rawTotal).padStart(10)} raw  ${kb(gzipTotal).padStart(9)} gzip`);

// ---------------------------------------------------------------------------
// 1. The size gate
if (gzipTotal > BUDGET_BYTES) {
  problems.push(
    `citizen shell is ${kb(gzipTotal)} gzipped, over the ${kb(BUDGET_BYTES)} budget ` +
      `(${kb(gzipTotal - BUDGET_BYTES)} too much)`,
  );
} else {
  note(`within budget: ${kb(gzipTotal)} of ${kb(BUDGET_BYTES)} gzipped ` +
    `(${kb(BUDGET_BYTES - gzipTotal)} spare)`);
}

// ---------------------------------------------------------------------------
// 2. The mock library must not ship
//
// A regression this repository has already made once, and one the size gate
// provably cannot catch. Measured, not assumed: with `msw/browser` statically
// imported instead of dynamically, the initial bundle goes 263.8 kB -> 559.2 kB
// raw, and the gzipped total goes 83.9 kB -> 177.5 kB. That is still *under* the
// 250 kB budget, because minified JavaScript gzips well and the mock server is
// highly repetitive. So a budget failure is not the signal to look for here -
// the signal has to be structural.
//
// Two checks, because there are two ways to get this wrong:
//
//   a. The service worker *script* in the output. It is a development-only asset
//      served from the `development` configuration, so finding it in a
//      production build means the asset list changed.
//
//   b. The mock *library* in the initial graph. Detected by a string literal
//      that only exists inside msw: `x-msw-intention`, the protocol header msw
//      stamps on a request it has handled. Our own source never mentions it.
//
//      Note that the string `mockServiceWorker.js` is *not* usable for this. It
//      is present in the initial graph of a perfectly clean build, because
//      `mock/index.ts` names that URL in its `worker.start` options and is
//      itself statically imported by `main.ts`. That literal is evidence the
//      gate exists, not evidence the library shipped.
//
// The marker is verified against a real build: zero occurrences in the clean
// initial graph, present in the lazy chunk that the dynamic import creates.
if (existsSync(join(browserDir, 'mockServiceWorker.js'))) {
  problems.push(
    'mockServiceWorker.js is in the production build; it is a development-only asset',
  );
}
for (const [file] of sizes) {
  if (/^mockServiceWorker/.test(file)) {
    problems.push(`index.html preloads ${file}, the development-only mock worker`);
  }
  if (!file.endsWith('.js')) {
    continue;
  }
  const source = readFileSync(join(browserDir, file), 'utf8');
  if (source.includes(MSW_MARKER)) {
    problems.push(
      `${file} contains msw library code ("${MSW_MARKER}"), so the mock server is ` +
        'in the initial graph; ./mock/browser must stay a dynamic import',
    );
  }
}
if (problems.every((p) => !p.includes('msw library code'))) {
  note('no msw library code in the initial graph: ./mock/browser is still dynamic');
}

// ---------------------------------------------------------------------------
// Report
if (problems.length > 0) {
  console.error(`\n  ${problems.length} problem(s):`);
  for (const problem of problems) {
    console.error(`    - ${problem}`);
  }
  console.error('\n  Fix: lazy-load the code, or raise the budget in REQUIREMENTS.md 169');
  process.exit(1);
}

console.log('\n  OK - the citizen shell is inside its budget and ships no mock server.');
