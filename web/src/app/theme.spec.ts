import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The SCSS source is read rather than imported, because that is what makes this
// a real check: the file under assertion is the same file the theme compiles
// from. A second copy of the colours in TypeScript would be a second thing to
// forget to update, and the test would keep passing after someone recoloured
// the app.
const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const tokensPath = join(srcDir, 'styles', '_tokens.scss');
const tokens = readFileSync(tokensPath, 'utf8');

// The theme source, read for the `--ant-*` and `--cl-*` mappings. Those
// mappings are what NG-ZORRO and application CSS consume, so they are what has
// to cover every token.
const themePath = join(srcDir, 'styles', '_civiclens-theme.scss');
const themeSource = readFileSync(themePath, 'utf8');

// NG-ZORRO's own stylesheet, read to establish what the library *ships*. This is
// the half of the test that cannot be satisfied by editing our own file, and
// without it "we themed it accessibly" is unfalsifiable - a CivicLens token file
// that is never loaded passes every check below.
const zorroPath = join(
  srcDir,
  '..',
  'node_modules',
  'ng-zorro-antd',
  'ng-zorro-antd.variable.min.css',
);
const zorro = readFileSync(zorroPath, 'utf8');

const angularJson = JSON.parse(readFileSync(join(srcDir, '..', 'angular.json'), 'utf8'));
const styleOrder: string[] = angularJson.projects.web.architect.build.options.styles;

// WCAG 2.1 relative luminance and contrast ratio.
//
// Implemented here rather than pulled from a package on purpose: the gate is
// "these specific colours meet these specific floors", and a dependency free to
// change its own rounding would make the gate weaker than the twenty lines it
// replaces.
const toLinear = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);

const relativeLuminance = (hex: string): number => {
  const clean = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    throw new Error(`not a 6-digit hex colour: "${hex}"`);
  }
  const [r, g, b] = [0, 2, 4].map((i) => toLinear(parseInt(clean.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrastRatio = (a: string, b: string): number => {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
};

/** Resolves `$name: #rrggbb;` from the real token source. */
const token = (name: string): string => {
  const match = new RegExp(`^\\$${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`, 'm').exec(tokens);
  if (!match) throw new Error(`token $${name} not found in _tokens.scss`);
  return match[1];
};

/** Reads the default NG-ZORRO ships for an `--ant-*` property. */
const zorroDefault = (property: string): string => {
  const match = new RegExp(`${property}:\\s*(#[0-9a-fA-F]{6})`, 'i').exec(zorro);
  if (!match) throw new Error(`NG-ZORRO declares no default for ${property}`);
  return match[1];
};

/**
 * The measured pairs, read from `$contrast-pairs` in `_tokens.scss`.
 *
 * Sourced from the SCSS rather than restated here, because that list is what
 * documents *why* each colour exists and the two would drift the first time
 * somebody added a pairing. The format is positional, so the labels are carried
 * through from the source and the purpose string is used in the failure message.
 */
const pairBlock = tokens.slice(tokens.indexOf('$contrast-pairs'));
const pairs: Array<{ label: string; fg: string; bg: string; min: number; purpose: string }> = [
  ...pairBlock.matchAll(
    /\(\s*'([^']+)'\s*,\s*\$([a-z0-9-]+)\s*,\s*\$([a-z0-9-]+)\s*,\s*([\d.]+)\s*,\s*'([^']*)'\s*,?\s*\)/g,
  ),
].map((m) => ({ label: m[1], fg: m[2], bg: m[3], min: parseFloat(m[4]), purpose: m[5] }));

// Text is held to 4.5:1 everywhere. 3:1 is legitimate only for non-text
// boundaries and focus indicators, so the relaxed rows are enumerated rather
// than left to pattern-matching - a future component rendering body copy at
// 3:1 should have to edit this list to get past the gate.
//
// Named by foreground token. `primary` covers both `primary on surface` (an
// icon) and `primary on surface-container` (a link in a card); the second is text
// and is held to 4.5 in the list above, so this set only has to admit the
// genuinely non-text rows. The `*-outline` family is here for the same reason:
// those exist to draw a ring or a divider, and WCAG 1.4.11 is about the boundary
// being visible, not about the text on top of it.
const NON_TEXT_ONLY = new Set([
  'primary',
  'outline',
  'outline-variant',
  'primary-outline',
  'error-outline',
  'success-outline',
  'warning-outline',
  'focus',
]);

/**
 * Each `--ant-*` property CivicLens takes responsibility for, paired with the
 * CivicLens token that replaces it and the text token that sits on top.
 *
 * The third column is what makes the last test in this group meaningful: it is
 * the pairing that has to clear 4.5:1, not merely "is a different hex than the
 * library's".
 */
const SEMANTIC_OVERRIDES: Array<[property: string, tokenName: string, onToken: string]> = [
  ['--ant-primary-color', 'primary', 'on-primary'],
  ['--ant-primary-color-hover', 'primary-hover', 'on-primary'],
  ['--ant-primary-color-active', 'primary-active', 'on-primary'],
  ['--ant-error-color', 'error', 'on-error'],
  ['--ant-error-color-hover', 'error-hover', 'on-error'],
  ['--ant-error-color-active', 'error-active', 'on-error'],
  ['--ant-success-color', 'success', 'on-success'],
  ['--ant-success-color-hover', 'success-hover', 'on-success'],
  ['--ant-success-color-active', 'success-active', 'on-success'],
  ['--ant-warning-color', 'warning', 'on-warning'],
  ['--ant-warning-color-hover', 'warning-hover', 'on-warning'],
  ['--ant-warning-color-active', 'warning-active', 'on-warning'],
  ['--ant-info-color', 'info', 'on-info'],
];

// The semantic colours in the `variable` build that CivicLens has to set. Every
// one is listed rather than matched by regex, so a property the library adds
// later surfaces as a failure to *choose a token for it* instead of quietly
// shipping a default.
const ALL_SEMANTIC_PROPERTIES = [
  '--ant-primary-color',
  '--ant-primary-color-hover',
  '--ant-primary-color-active',
  '--ant-primary-color-outline',
  '--ant-error-color',
  '--ant-error-color-hover',
  '--ant-error-color-active',
  '--ant-success-color',
  '--ant-success-color-hover',
  '--ant-success-color-active',
  '--ant-warning-color',
  '--ant-warning-color-hover',
  '--ant-warning-color-active',
  '--ant-info-color',
];

/**
 * Custom properties this theme sets that NG-ZORRO 22.1.1 does not read.
 *
 * These are deliberate, not a defect: they are the hover/active/outline states of
 * the success and warning palettes, which the library declares defaults for but
 * draws with hard-coded `rgba()` in the current version. Setting them now means a
 * future NG-ZORRO that starts reading them ships CivicLens colours rather than
 * Ant defaults, with no theme edit at the time of the upgrade.
 *
 * The cost is that they are currently inert, so they are listed here rather than
 * counted as coverage by the test below. The test fails if any of them *becomes*
 * read, which is the prompt to move it into the real assertions.
 */
const UNREAD_BY_DESIGN = new Set([
  '--ant-success-color-hover',
  '--ant-success-color-active',
  '--ant-success-color-outline',
  '--ant-warning-color-active',
]);

describe('CivicLens accessible theme', () => {
  it('found the contrast pair list it is meant to check', () => {
    // Guards the regex above. If `$contrast-pairs` is renamed or reformatted,
    // every `it.each` below silently runs zero cases and this suite goes green
    // having tested nothing - which is the exact failure mode this file exists
    // to prevent.
    expect(pairs.length, 'no contrast pairs parsed from $contrast-pairs').toBeGreaterThan(20);
  });

  it.each(pairs)('$label clears $min:1 ($purpose)', ({ fg, bg, min, purpose }) => {
    const ratio = contrastRatio(token(fg), token(bg));
    const readable = `${token(fg)} on ${token(bg)} is ${ratio.toFixed(2)}:1 but needs ${min}:1 for ${purpose}`;
    expect(ratio, readable).toBeGreaterThanOrEqual(min);
  });

  it('only relaxes the threshold for genuinely non-text pairings', () => {
    for (const { fg, min } of pairs) {
      if (min < 4.5) {
        expect(NON_TEXT_ONLY, `${fg} is text but is held to only ${min}:1`).toContain(fg);
      }
    }
  });

  it('keeps the focus ring above the 3:1 non-text threshold', () => {
    // The ring is painted with `--cl-outline`, so this asserts the thing a
    // keyboard user actually depends on rather than a token nothing renders.
    expect(contrastRatio(token('outline'), token('surface'))).toBeGreaterThanOrEqual(3);
  });

  it('declares a real measured ratio in the comment beside every token', () => {
    // A colour added without a stated floor is how a palette quietly stops being
    // AA while still looking deliberate. The second half is the stricter claim:
    // the comment has to state the ratio it actually measures, so a token cannot
    // be recoloured and leave a confident, wrong number next to it.
    //
    // Two comment shapes are accepted. Most tokens say "N:1 with $other-token",
    // which this can re-measure and check. The `*-outline` family says "N:1 on
    // surface" and names a role rather than a token; those are counted as
    // declared but not re-measured, because the pairing is a WCAG 1.4.11 boundary
    // and re-deriving it would mean deciding which surface it is drawn on.
    const measured = [
      ...tokens.matchAll(
        /^\$([a-z0-9-]+):\s*(#[0-9a-fA-F]{6});\s*\/\/\s*([\d.]+):1\s*with\s+\$([a-z0-9-]+)/gm,
      ),
    ];
    const declaredOnly = [
      ...tokens.matchAll(
        /^\$[a-z0-9-]+:\s*#[0-9a-fA-F]{6};\s*\/\/\s*[\d.]+:1\s*on\s+[a-z-]+/gm,
      ),
    ];
    const tokenCount = (tokens.match(/^\$[a-z0-9-]+:\s*#[0-9a-fA-F]{6};/gm) ?? []).length;

    expect(
      measured.length + declaredOnly.length,
      'every colour token must state its measured ratio',
    ).toBe(tokenCount);

    for (const [, name, hex, stated, against] of measured) {
      const actual = contrastRatio(hex, token(against));
      expect(
        actual,
        `$${name} is ${actual.toFixed(2)}:1 with $${against}, but the comment says ${stated}:1`,
      ).toBeCloseTo(parseFloat(stated), 1);
    }
  });

  it('exposes every token to application CSS as a --cl-* custom property', () => {
    // Application components use `var(--cl-*)` rather than `var(--ant-*)`, so an
    // NG-ZORRO upgrade cannot rename a colour out from under a template. The
    // trade is a second list to keep current, so this asserts the mapping is
    // exhaustive: adding a token without exposing it, or exposing a token that
    // no longer exists, both fail here.
    // Note the digits in the character class: the tint ramp tokens are
    // `primary-1` .. `primary-7`, and a class that stopped at the hyphen would
    // match `--cl-primary-` seven times and report the ramp as unexposed.
    const exposed = new Set(
      [...themeSource.matchAll(/--cl-([a-z0-9-]+):/g)].map((match) => match[1]),
    );
    const tokenNames = [...tokens.matchAll(/^\$([a-z0-9-]+):\s*#/gm)].map((m) => m[1]);

    const missing = tokenNames.filter((name) => !exposed.has(name));
    expect(
      missing,
      `tokens not exposed to components: ${missing.join(', ')}`,
    ).toEqual([]);

    const stale = [...exposed].filter((name) => !tokenNames.includes(name));
    expect(stale, `--cl-* properties with no matching token: ${stale.join(', ')}`).toEqual([]);
  });
});

describe('NG-ZORRO integration', () => {
  it('loads the variable build before the CivicLens theme so overrides win', () => {
    // Both stylesheets target the same element with the same specificity, so
    // document order is the only thing deciding whether our palette or the
    // library's is the one that paints. Get this backwards and every colour
    // below is silently the default, with the whole suite still green.
    const zorroIndex = styleOrder.findIndex((s) => s.includes('ng-zorro-antd'));
    const themeIndex = styleOrder.findIndex((s) => s.includes('styles.scss'));

    expect(zorroIndex, 'angular.json must load an NG-ZORRO stylesheet').toBeGreaterThanOrEqual(0);
    expect(
      zorroIndex,
      'NG-ZORRO must be listed before styles.scss or its defaults win the cascade',
    ).toBeLessThan(themeIndex);
  });

  it('uses the variable build, so the palette is overridable at all', () => {
    // The default `ng-zorro-antd.min.css` hard-codes its palette onto element
    // selectors. The theme here sets `--ant-*` custom properties, which that
    // build never reads - swapping it in would drop every colour correction
    // below while leaving this file looking correct.
    expect(styleOrder.join('\n')).toContain('ng-zorro-antd.variable.min.css');
  });

  it('overrides every semantic colour NG-ZORRO ships a default for', () => {
    const set = new Set([...themeSource.matchAll(/(--ant-[a-z0-9-]+):/g)].map((m) => m[1]));
    const missing = ALL_SEMANTIC_PROPERTIES.filter((property) => !set.has(property));
    expect(
      missing,
      `NG-ZORRO defaults that would ship unthemed: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it.each(SEMANTIC_OVERRIDES)(
    '%s is a CivicLens token, not the library default',
    (property, tokenName) => {
      // The override has to name a token that exists, so this fails on a rename
      // in `_tokens.scss` as well as on a missing override.
      const ours = token(tokenName);
      const theirs = zorroDefault(property);
      expect(
        ours,
        `${property} is #${ours}, the same as NG-ZORRO's default #${theirs} ($${tokenName})`,
      ).not.toBe(theirs);
    },
  );

  it.each(SEMANTIC_OVERRIDES)(
    '%s carries %s text at 4.5:1, which is the whole reason it is overridden',
    (property, tokenName, onToken) => {
      const ours = contrastRatio(token(onToken), token(tokenName));
      expect(
        ours,
        `${token(onToken)} on ${token(tokenName)} is ${ours.toFixed(2)}:1, needs 4.5:1`,
      ).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('would fail the AA floor with the library defaults, so the override is load-bearing', () => {
    // The mirror image of the assertion above, and the reason any of this exists:
    // measure NG-ZORRO's own defaults for the same pairings and record that they
    // fall short.
    //
    // This is asserted as "at least one fails" rather than "all fail" on purpose.
    // An NG-ZORRO upgrade that fixes one of them would otherwise turn a passing
    // suite red for a change that is an improvement, and the reaction to a red
    // suite is to loosen the test - which is how a gate quietly stops being one.
    // A partial improvement is a reason to revisit the palette, not a reason to
    // stop checking it.
    const failures: string[] = [];
    for (const [property, , onToken] of SEMANTIC_OVERRIDES) {
      const theirs = zorroDefault(property);
      const ratio = contrastRatio(token(onToken), theirs);
      if (ratio < 4.5) {
        failures.push(`${property} ${theirs}: ${token(onToken)} on it is ${ratio.toFixed(2)}:1`);
      }
    }

    expect(
      failures.length,
      `NG-ZORRO's defaults now clear 4.5:1 for every pairing this app uses: ${failures.join('; ')}. ` +
        'Revisit the palette - some overrides may no longer be needed.',
    ).toBeGreaterThan(0);
  });

  it('maps the Ant primary tint ramp so a hover wash cannot drift to the default blue', () => {
    // `--ant-primary-1` .. `-7` are separate properties with separate defaults,
    // and they are what sits behind a selected table row. A theme that sets
    // only `--ant-primary-color` leaves the ramp blue.
    for (let step = 1; step <= 7; step++) {
      const property = `--ant-primary-${step}`;
      expect(themeSource, `${property} is not themed`).toContain(`${property}:`);
    }

    // And the ramp itself has to be ordered: light to dark, so the wash behind a
    // selected row is lighter than the pressed button below it.
    const ramp = [1, 2, 3, 4, 5, 6, 7].map((step) => token(`primary-${step}`));
    for (let i = 1; i < ramp.length; i++) {
      const previous = contrastRatio(ramp[i - 1], token('surface'));
      const current = contrastRatio(ramp[i], token('surface'));
      expect(
        current,
        `primary-${i + 1} (${ramp[i]}, ${current.toFixed(2)}:1 on surface) is not darker than primary-${i} (${ramp[i - 1]}, ${previous.toFixed(2)}:1)`,
      ).toBeGreaterThan(previous);
    }

    // Steps 1-4 sit behind dark text, 5-7 carry white text. Both halves are
    // asserted because a ramp that is only ordered is not necessarily legible.
    for (const step of [1, 2, 3, 4]) {
      expect(
        contrastRatio(token('on-surface'), token(`primary-${step}`)),
        `on-surface on primary-${step}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    for (const step of [5, 6, 7]) {
      expect(
        contrastRatio(token('on-primary'), token(`primary-${step}`)),
        `on-primary on primary-${step}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('reaches the defaults no custom property covers', () => {
    // NG-ZORRO's `variable` build exposes 43 custom properties, all of them
    // shades of a semantic colour. Secondary text, links, disabled labels, and
    // placeholders are painted from `rgba()` values baked into component rules -
    // unoverridable from `:root`, and four separate ways for a citizen to be
    // handed text below 4.5:1. These are patched by selector in
    // `civiclens-antd-overrides()` and this is the list of what it must patch.
    const required: Array<[selector: string, tokenName: string, what: string]> = [
      ['.ant-typography-secondary', 'on-surface-variant', 'secondary text'],
      ['.ant-form-item-extra', 'on-surface-variant', 'field help text'],
      ['.ant-btn-link', 'primary', 'a link-styled button'],
      ['.ant-btn[disabled]', 'on-surface-disabled', 'a disabled control label'],
      ['.ant-input::placeholder', 'on-surface-placeholder', 'a field placeholder'],
    ];

    for (const [selector, tokenName, what] of required) {
      expect(themeSource, `${what} (${selector}) is not overridden`).toContain(selector);
      expect(themeSource, `${selector} does not use $${tokenName}`).toContain(
        `var(--cl-${tokenName})`,
      );
    }

    // And the replacements are themselves measured, not merely present.
    expect(contrastRatio(token('on-surface-variant'), token('surface'))).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(token('on-surface-disabled'), token('surface')),
      'a disabled label still has to be readable',
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(token('on-surface-placeholder'), token('surface')),
      'a placeholder is often the only instruction a field gives',
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('only sets custom properties the library actually reads', () => {
    // Every rule above this one in this suite assumes an override takes effect.
    // A custom property the library never references is a rule that does
    // nothing while reading as a working theme, and nothing else in the project
    // would notice: the contrast tests measure our tokens, not whether anything
    // paints them. That is not hypothetical - `--ant-wave-shadow-color` sat in
    // the reduced-motion block for a while, one character away from the real
    // `--antd-wave-shadow-color`, silently disabling the only part of that block
    // that was not a blanket duration reset.
    //
    // NG-ZORRO is inconsistent about its own prefix: colour tokens are `--ant-*`
    // but the wave token is `--antd-*`, which is exactly why a typo is easy here
    // and hard to see. Asserting against the stylesheet that actually loads (the
    // order of which is checked above) makes the prefix question moot.
    const sources = [themePath, join(srcDir, 'styles.scss')].map((p) => readFileSync(p, 'utf8'));

    const declared = new Set(
      sources.flatMap((src) => [...src.matchAll(/(--[a-z0-9-]+)\s*:(?=\s*#\{|\s*transparent|\s*0)/g)]).map(
        (m) => m[1],
      ),
    );

    // `--cl-*` is ours by design and is read by application CSS, not by NG-ZORRO.
    const libraryOwned = [...declared].filter((p) => p.startsWith('--ant'));

    const unread = libraryOwned.filter(
      (property) => !new RegExp(`var\\(\\s*${property}\\s*[,)]`).test(zorro),
    );

    expect(
      unread.filter((p) => !UNREAD_BY_DESIGN.has(p)),
      `custom properties the NG-ZORRO stylesheet never references, so these overrides do nothing: ${
        unread.join(', ')
      }`,
    ).toEqual([]);

    // The allowlist is allowed to go stale in one direction only. A property that
    // has since become read is no longer a forward-compatibility override but a
    // live one, and it is promoted to the real assertions above rather than left
    // to rot here.
    const nowRead = [...UNREAD_BY_DESIGN].filter((p) =>
      new RegExp(`var\\(\\s*${p}\\s*[,)]`).test(zorro),
    );
    expect(
      nowRead,
      `these are read by the library now, so drop them from UNREAD_BY_DESIGN and assert them directly: ${nowRead.join(', ')}`,
    ).toEqual([]);
  });
});
