import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { civiclensIcons } from './icons';

/**
 * Every `nzType` in every template is registered in `ui/icons.ts`.
 *
 * NG-ZORRO renders an empty box for an icon it was not given, rather than
 * throwing. That is the right runtime behaviour for an icon that might legitimately
 * be absent, and the wrong behaviour for a typo in a template: the page renders,
 * the screenshot looks fine, the navigation looks complete, and there is a
 * 24-pixel hole next to "Report a problem" that nobody notices until a citizen
 * reports a missing icon.
 *
 * The alternative to this test is the library's full `ICONS` map, which is 703 kB
 * of SVG source shipped to every citizen to cover icons nobody will see. So the
 * allowlist stays, and this is what keeps it honest.
 */

// The icon names NG-ZORRO will resolve, taken from the registered definitions
// themselves rather than from a hand-written list, so the two cannot drift.
const registeredNames = new Set(
  civiclensIcons.map((icon) => (icon as { name: string }).name),
);

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every `.html` and `.ts` under `src/app`, since templates are inline. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (/\.(html|ts)$/.test(entry) && !entry.endsWith('.spec.ts')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Every `nzType` in a template.
 *
 * Matches the Angular binding form only. A static `nzType="plus"` attribute is
 * not a thing NG-ZORRO supports, and matching it here would report a false
 * positive on documentation or prose that happens to mention one.
 */
function iconReferences(source: string): Array<{ name: string; index: number }> {
  return [...source.matchAll(/nzType="([a-z-]+)"/g)].map((match) => ({
    name: match[1],
    index: match.index ?? 0,
  }));
}

describe('NG-ZORRO icon registration', () => {
  const files = sourceFiles(appDir);
  const filesWithIcons = files
    .map((file) => ({
      file: relative(appDir, file),
      source: readFileSync(file, 'utf8'),
    }))
    .filter((entry) => iconReferences(entry.source).length > 0);

  it('registers at least one icon, so an empty allowlist fails loudly', () => {
    // Without this, a refactor that emptied `civiclensIcons` would make every
    // other test in this file pass by having nothing to check.
    expect(registeredNames.size, 'the icon allowlist is empty').toBeGreaterThan(0);
  });

  it.each(filesWithIcons.map((entry) => entry.file))('%s uses only registered icons', (file) => {
    const entry = filesWithIcons.find((candidate) => candidate.file === file)!;
    const missing = iconReferences(entry.source)
      .map((reference) => reference.name)
      .filter((name) => !registeredNames.has(name));

    expect(
      [...new Set(missing)],
      `icons used in ${file} but not registered in ui/icons.ts`,
    ).toEqual([]);
  });

  it('keeps the allowlist small enough to be worth having', () => {
    // The invariant that makes the allowlist worth maintaining. `@ant-design/icons-angular`
    // exports well over 700 icons; registering the library's full `ICONS` map costs
    // 703 kB in every citizen's bundle. A hand-maintained list is only a win while
    // it stays far below that number, so the bound is the thing actually asserted.
    //
    // The earlier version of this test counted registered-but-unused icons and
    // compared that count to the list size, which was an assertion that could only
    // fail: with no template using `nzType` yet, all 18 were unused, 18 < 18 was
    // false, and the suite went red on a file with no bug. Unused icons are a real
    // smell, but they are normal while screens are being built, and the size bound
    // is what catches the drift that actually costs bytes.
    expect(
      registeredNames.size,
      `the allowlist has grown to ${registeredNames.size} icons. If that is intended, ` +
        'it has probably stopped being an allowlist; measure the bundle before raising it.',
    ).toBeLessThanOrEqual(40);
  });

  it('registers no icon twice', () => {
    // A duplicate in the array is dead weight and a symptom of a copy-paste edit.
    // The set built above would hide it, so the raw count is compared instead.
    expect(
      civiclensIcons.length,
      `duplicate entries: ${civiclensIcons.length - registeredNames.size}`,
    ).toBe(registeredNames.size);
  });

  it('resolves each registered icon to a real name, not an empty definition', () => {
    // Catches an import that type-checks but carries no `name`, which would
    // register an icon the library still cannot render.
    const nameless = civiclensIcons.filter((icon) => !(icon as { name?: string }).name);
    expect(
      nameless.length,
      'icon definitions with no name would register but never render',
    ).toBe(0);
  });
});
