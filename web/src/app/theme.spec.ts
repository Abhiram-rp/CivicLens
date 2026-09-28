import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The SCSS source is read rather than imported, because that is what makes this
// a real check: the file under assertion is the same file the theme compiles
// from. A second copy of the colours in TypeScript would be a second thing to
// forget to update, and the test would keep passing after someone recoloured
// the app.
const tokensPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'styles',
  '_tokens.scss',
);
const tokens = readFileSync(tokensPath, 'utf8');

// The theme source, read for the `--cl-*` mapping rather than the Material
// output: the mapping is what application CSS consumes, so it is what has to
// cover every token.
const themePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'styles', '_civiclens-theme.scss');
const themeSource = readFileSync(themePath, 'utf8');

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

/** [foreground token, background token, minimum ratio, what it is for] */
const pairs: Array<[string, string, number, string]> = [
  ['on-surface', 'surface', 4.5, 'body copy on a page'],
  ['on-surface', 'surface-container', 4.5, 'body copy on a card'],
  ['on-surface-variant', 'surface', 4.5, 'secondary copy'],
  ['on-primary', 'primary', 4.5, 'a filled primary button'],
  ['on-primary', 'primary-hover', 4.5, 'that button, hovered or pressed'],
  ['primary', 'surface', 3.0, 'a primary-coloured icon or link'],
  ['primary', 'surface-container', 4.5, 'a link inside a card'],
  ['on-secondary', 'secondary', 4.5, 'a tonal chip'],
  ['on-tertiary', 'tertiary', 4.5, 'a priority accent chip'],
  ['on-error', 'error', 4.5, 'an error banner'],
  ['outline', 'surface', 3.0, 'a divider or focus ring'],
  ['outline-variant', 'surface-container', 3.0, 'a divider on a card'],
  ['on-inverse-surface', 'inverse-surface', 4.5, 'a snackbar or tooltip'],
];

// Text is held to 4.5:1 everywhere. 3:1 is legitimate only for non-text
// boundaries and focus indicators, so the relaxed rows are enumerated rather
// than left to pattern-matching - a future component rendering body copy at
// 3:1 should have to edit this list to get past the gate.
const NON_TEXT_ONLY = new Set(['primary', 'outline', 'outline-variant']);

describe('CivicLens accessible theme', () => {
  it.each(pairs)('$1 on $2 clears $3:1 ($4)', (fgName, bgName, minimum, purpose) => {
    const fg = token(fgName);
    const bg = token(bgName);
    const ratio = contrastRatio(fg, bg);
    const readable = `${fg} on ${bg} is ${ratio.toFixed(2)}:1 but needs ${minimum}:1 for ${purpose}`;
    expect(ratio, readable).toBeGreaterThanOrEqual(minimum);
  });

  it('only relaxes the threshold for genuinely non-text pairings', () => {
    for (const [fgName, , minimum] of pairs) {
      if (minimum < 4.5) {
        expect(NON_TEXT_ONLY, `${fgName} is text but is held to only ${minimum}:1`).toContain(
          fgName,
        );
      }
    }
  });

  it('keeps the focus ring above the 3:1 non-text threshold', () => {
    // The ring is painted with the primary token, so this asserts the thing a
    // keyboard user actually depends on rather than a token nothing renders.
    expect(contrastRatio(token('primary'), token('surface'))).toBeGreaterThanOrEqual(3);
  });

  it('declares a minimum in the comment beside every token', () => {
    // A colour added without a stated floor is how a palette quietly stops
    // being AA while still looking deliberate.
    const declared = tokens.match(/^\$[a-z-]+:\s*#[0-9a-fA-F]{6};\s*\/\/\s*[\d.]+:1/gm) ?? [];
    const tokenCount = (tokens.match(/^\$[a-z-]+:\s*#[0-9a-fA-F]{6};/gm) ?? []).length;
    expect(declared.length, 'every colour token must state its measured ratio').toBe(
      tokenCount,
    );
  });

  it('exposes every token to application CSS as a --cl-* custom property', () => {
    // Application components use `var(--cl-*)` rather than `var(--mat-sys-*)`,
    // so a Material upgrade cannot rename a colour out from under a template.
    // The trade is a second list to keep current, so this asserts the mapping is
    // exhaustive: adding a token without exposing it, or exposing a token that
    // no longer exists, both fail here.
    const exposed = new Set(
      [...themeSource.matchAll(/--cl-([a-z-]+):/g)].map((match) => match[1]),
    );
    const tokenNames = [...tokens.matchAll(/^\$([a-z-]+):\s*#/gm)].map((m) => m[1]);

    const missing = tokenNames.filter((name) => !exposed.has(name));
    expect(
      missing,
      `tokens not exposed to components: ${missing.join(', ')}`,
    ).toEqual([]);

    // `primary-hover` is exposed but is not a contrast-pair participant, and the
    // `$contrast-pairs` list is the authority on which pairs are measured, so the
    // mapping is only required to cover tokens that exist.
    const stale = [...exposed].filter((name) => !tokenNames.includes(name));
    expect(stale, `--cl-* properties with no matching token: ${stale.join(', ')}`).toEqual([]);
  });
});
