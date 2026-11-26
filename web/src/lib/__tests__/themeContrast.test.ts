/**
 * WCAG contrast of the theme tokens, read straight from src/index.css: the dark set (@theme) and
 * the light set (:root[data-theme="light"]). If a token value changes and breaks AA, this fails.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEME_COLORS } from '../theme';

const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8');

function block(selectorRe: RegExp): string {
  const m = selectorRe.exec(css);
  if (!m) throw new Error(`block ${selectorRe} not found in index.css`);
  const start = css.indexOf('{', m.index) + 1;
  return css.slice(start, css.indexOf('}', start));
}

/** `--color-x: #rrggbb;` declarations of a block (hex values only). */
function hexTokens(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)) out[m[1]] = m[2].toLowerCase();
  return out;
}

const dark = hexTokens(block(/@theme(?:\s+static)?\s*\{/));
const lightOnly = hexTokens(block(/:root\[data-theme="light"\]\s*\{/));
const light = { ...dark, ...lightOnly };
const THEMES = { dark, light } as const;

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (h: string) => {
  const [r, g, b] = rgb(h).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** sRGB mix of `a` at fraction t over `b` (what `bg-x/20` composites to over an opaque bg). */
const over = (a: string, b: string, t: number) => {
  const A = rgb(a);
  const B = rgb(b);
  return '#' + A.map((v, i) => Math.round((v * t + B[i] * (1 - t)) * 255).toString(16).padStart(2, '0')).join('');
};

const SURFACES = ['ink-950', 'ink-900', 'ink-850', 'ink-800', 'ink-750'];
const AA = 4.5;

describe('theme tokens', () => {
  it('parses both token sets', () => {
    expect(Object.keys(dark).length).toBeGreaterThan(25);
    expect(Object.keys(lightOnly).length).toBeGreaterThan(25);
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });

  it('light redefines only tokens that exist in dark', () => {
    for (const k of Object.keys(lightOnly)) expect(dark, `--color-${k}`).toHaveProperty(k);
  });

  it('the ink scale inverts in light: the page is light and the text is dark', () => {
    expect(lum(light['ink-950'])).toBeGreaterThan(lum(light['paper']));
    expect(lum(dark['ink-950'])).toBeLessThan(lum(dark['paper']));
  });

  for (const [name, t] of Object.entries(THEMES)) {
    describe(name, () => {
      const check = (fg: string, bg: string, min: number, bgHex = t[bg]) => {
        const r = contrast(t[fg], bgHex);
        expect(r, `${name}: ${fg} on ${bg} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(min);
      };

      it('body text tokens reach AA on every surface', () => {
        for (const fg of ['paper', 'ink-200', 'ink-300', 'ink-400']) for (const bg of SURFACES) check(fg, bg, AA);
        // ink-700 is a hairline / secondary-button fill: only primary and secondary text sit on it.
        for (const fg of ['paper', 'ink-200', 'ink-300']) check(fg, 'ink-700', AA);
      });

      it('accent text and primary buttons reach AA', () => {
        for (const bg of SURFACES) check('accent-300', bg, AA);
        check('on-accent', 'accent-500', AA);
        check('on-accent', 'accent-600', AA);
      });

      it('sun accent text reaches AA on every surface', () => {
        for (const fg of ['sun-300', 'sun-400']) for (const bg of SURFACES) check(fg, bg, AA);
      });

      it('text on the sun accent reaches AA (on-sun and ink-950)', () => {
        check('on-sun', 'sun-500', AA);
        check('on-sun', 'sun-400', AA);
        check('ink-950', 'sun-500', AA);
      });

      it('provenance, shade and error text reach AA on panels and cards', () => {
        for (const fg of ['obs', 'inf', 'map', 'asm', 'man', 'shade-400', 'danger-text']) for (const bg of ['ink-900', 'ink-850']) check(fg, bg, AA);
      });

      it('provenance chips (colour on a 14% tint of itself) reach AA', () => {
        for (const p of ['obs', 'inf', 'map', 'asm', 'man']) check(p, 'ink-850', AA, over(t[p], t['ink-850'], 0.14));
      });

      it('notice pills reach AA (warning and error tints)', () => {
        check('sun-300', 'ink-900', AA, over(t['sun-600'], t['ink-900'], 0.2));
        check('danger-text', 'ink-900', AA, over(t['danger'], t['ink-900'], 0.2));
      });

      it('sunlight data-vis fills reach 3:1 (WCAG 1.4.11): lit on panels and tracks, lit next to facing-away', () => {
        for (const bg of ['ink-900', 'ink-850', 'ink-800']) check('lit', bg, 3);
        check('lit', 'away', 3);
        // SunReport bars are bg-lit/85 on the ink-850 card.
        check('ink-850', 'ink-850', 3, over(t['lit'], t['ink-850'], 0.85));
      });

      it('the focus ring and selection outline (accent) reach 3:1 against every surface', () => {
        for (const bg of SURFACES) check('accent', bg, 3);
      });

      it('THEME_COLORS (non-CSS consumers) match the CSS tokens', () => {
        const c = THEME_COLORS[name as 'dark' | 'light'];
        expect(c.pageBg.toLowerCase()).toBe(t['ink-950']);
        expect(`#${c.photoBg.toString(16).padStart(6, '0')}`).toBe(t['ink-950']);
        expect(c.overlayText.toLowerCase()).toBe(t['paper']);
      });
    });
  }
});

/* Tailwind palette text colours (text-red-300, text-white, …) do not follow the theme: in light they
 * sit on a cream page at ~1.2–2:1. Components must use the theme tokens (text-danger-text, …). */
describe('no theme-blind palette colours in components', () => {
  it('TSX uses tokens, not Tailwind palette text/background colours', async () => {
    const { readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = fileURLToPath(new URL('../../components', import.meta.url));
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.tsx')) files.push(p);
      }
    };
    walk(root);
    const bad: string[] = [];
    const re = /\b(?:text|bg|ring)-(?:white|black|(?:red|rose|orange|amber|yellow|green|emerald|blue|sky|slate|gray|zinc)-\d{2,3})\b/g;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(re)) bad.push(`${f.split('/components/')[1]}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });
});
