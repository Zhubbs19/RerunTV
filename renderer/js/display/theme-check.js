// Theme contrast check (docs/design/04 §4.4). Resolves a theme's tokens and
// checks the pairs text actually sits on. A failing theme still loads: the
// theme browser badges it "Low contrast" and Plug-ins › Diagnostics lists the
// failing pairs. A pack can exempt a pair with a reason
// (registerThemePack's `contrastExempt: { 'text-muted/surface-1': 'why' }`);
// an exempt pair is still reported and still badged, as "(exempt)".
import { backgroundLayers, flattenLayers, parseColor, toHex, worstContrast } from './contrast.js';

// ---------- Pure ----------
// fg: a colour token. bg: a background token (colour or gradient). under: the
// surface a translucent or transparent bg shows through to (itself flattened
// over black). min: the WCAG ratio required.
export const THEME_CHECK_PAIRS = [
  { id: 'text/surface-0', fg: '--text', bg: '--surface-0', min: 4.5 },
  { id: 'text/surface-1', fg: '--text', bg: '--surface-1', min: 4.5 },
  { id: 'text/surface-2', fg: '--text', bg: '--surface-2', under: '--surface-1', min: 4.5 },
  { id: 'text/surface-3', fg: '--text', bg: '--surface-3', under: '--surface-1', min: 4.5 },
  { id: 'text/surface-panel', fg: '--text', bg: '--surface-panel', under: '--surface-1', min: 4.5 },
  { id: 'text-muted/surface-1', fg: '--text-muted', bg: '--surface-1', min: 4.5 },
  { id: 'control-text/control-bg', fg: '--control-text', bg: '--control-bg', under: '--surface-panel', min: 4.5 },
  { id: 'selected-text/selected-bg', fg: '--selected-text', bg: '--selected-bg', under: '--surface-1', min: 4.5 },
  { id: 'guide-rail-text/guide-rail-bg', fg: '--guide-rail-text', bg: '--guide-rail-bg', under: '--guide-grid-bg', min: 4.5 },
  { id: 'guide-cell-text/guide-cell-bg', fg: '--guide-cell-text', bg: '--guide-cell-bg', under: '--guide-grid-bg', min: 4.5 },
  { id: 'guide-selected-text/guide-selected-bg', fg: '--guide-selected-text', bg: '--guide-selected-bg', under: '--guide-grid-bg', min: 4.5 },
  { id: 'focus-ring/surface-0', fg: '--focus-ring', bg: '--surface-0', min: 3 },
  // Focus is a ring with a halo gap (docs/design/04 §3), so it sits on the halo,
  // never on a selected bar; one colour can't clear 3:1 on navy and gold both.
  { id: 'focus-ring/focus-halo', fg: '--focus-ring', bg: '--focus-halo', min: 3 },
  { id: 'danger-text/surface-1', fg: '--danger-text', bg: '--surface-1', min: 4.5 },
];

export const THEME_CHECK_TOKENS = Array.from(new Set(THEME_CHECK_PAIRS.flatMap((p) => [p.fg, p.bg, p.under]).filter(Boolean)));
// Tokens that may hold a gradient; the rest are plain colours.
export const BACKGROUND_TOKENS = new Set(THEME_CHECK_PAIRS.flatMap((p) => [p.bg, p.under]).filter(Boolean));

function surfaceCandidates(tokens, name, seen = new Set()) {
  const black = [{ r: 0, g: 0, b: 0, a: 1 }];
  if (!name || seen.has(name)) return black;
  seen.add(name);
  const layers = backgroundLayers(tokens[name]);
  if (!layers.length) return black;
  // A background token's own "under" is whatever pair names it first.
  const owner = THEME_CHECK_PAIRS.find((p) => p.bg === name && p.under);
  return flattenLayers(layers, surfaceCandidates(tokens, owner && owner.under, seen));
}

// tokens: { '--text': 'rgb(…)', '--surface-panel': 'linear-gradient(…)', … }
// as resolved values. Returns { failures, passed, unresolved }; a failure
// carries the worst ratio, the colours that produced it and any exemption.
export function checkThemeTokens(tokens, { exempt = {} } = {}) {
  const failures = [];
  const unresolved = [];
  let passed = 0;
  THEME_CHECK_PAIRS.forEach((pair) => {
    const fg = parseColor(tokens[pair.fg]);
    const bgLayers = backgroundLayers(tokens[pair.bg]);
    if (!fg || !bgLayers.length) { unresolved.push(pair.id); return; }
    const backgrounds = flattenLayers(bgLayers, surfaceCandidates(tokens, pair.under));
    const worst = worstContrast(fg, backgrounds);
    if (worst.ratio + 1e-9 >= pair.min) { passed += 1; return; }
    const reason = exempt && typeof exempt[pair.id] === 'string' && exempt[pair.id].trim() ? exempt[pair.id].trim() : null;
    failures.push({
      pair: pair.id,
      ratio: Math.round(worst.ratio * 100) / 100,
      min: pair.min,
      fg: toHex(worst.fg),
      bg: toHex(worst.bg),
      exempt: reason,
    });
  });
  return { failures, passed, unresolved };
}

// The badge a result earns: null (clean), 'low' or 'low-exempt'.
export function themeCheckBadge(result) {
  if (!result || !result.failures.length) return null;
  return result.failures.every((f) => f.exempt) ? 'low-exempt' : 'low';
}

// ---------- DOM ----------
// Theme tokens live on html[data-theme="x"], so reading another theme's
// values normally means switching the whole document, which restarts
// transitions and animations. Instead, copy the declarations out of the
// stylesheets onto a hidden probe — core :root first, then the theme's own
// blocks (and its TV refinements while in TV mode) — and let the browser
// resolve var() and color-mix() there.
const CORE_SELECTORS = new Set([':root', 'html']);

function themeSelectors(themeId, mode) {
  const theme = `[data-theme="${themeId}"]`;
  const set = new Set([`html${theme}`, `:root${theme}`]);
  if (mode === 'tv') {
    set.add(`html${theme}[data-mode="tv"]`);
    set.add(`html[data-mode="tv"]${theme}`);
  }
  return set;
}

function collectDeclarations(selectors) {
  const out = [];
  const visit = (rules) => {
    Array.from(rules || []).forEach((rule) => {
      if (rule.selectorText) {
        const parts = rule.selectorText.split(',').map((s) => s.trim());
        if (parts.some((s) => selectors.has(s))) {
          for (let i = 0; i < rule.style.length; i += 1) {
            const name = rule.style[i];
            if (name.startsWith('--')) out.push([name, rule.style.getPropertyValue(name)]);
          }
        }
      } else if (rule.cssRules && rule.constructor && rule.constructor.name === 'CSSSupportsRule') {
        visit(rule.cssRules);
      }
    });
  };
  Array.from(document.styleSheets).forEach((sheet) => {
    try { visit(sheet.cssRules); } catch (e) { /* a cross-origin sheet can't hold our tokens */ }
  });
  return out;
}

export function resolveThemeTokens(themeId, { mode = document.documentElement.dataset.mode || 'desktop' } = {}) {
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none;contain:strict;';
  const themeSet = themeSelectors(themeId, mode);
  const coreSet = new Set(CORE_SELECTORS);
  if (mode === 'tv') { coreSet.add('html[data-mode="tv"]'); coreSet.add(':root[data-mode="tv"]'); }
  [...collectDeclarations(coreSet), ...collectDeclarations(themeSet)].forEach(([name, value]) => probe.style.setProperty(name, value));
  const cells = THEME_CHECK_TOKENS.map((name) => {
    const cell = document.createElement('i');
    if (BACKGROUND_TOKENS.has(name)) {
      cell.style.backgroundImage = `var(${name})`;
      cell.style.backgroundColor = `var(${name})`;
    } else {
      cell.style.color = `var(${name}, transparent)`;
    }
    probe.appendChild(cell);
    return [name, cell];
  });
  document.body.appendChild(probe);
  const tokens = {};
  cells.forEach(([name, cell]) => {
    if (!probe.style.getPropertyValue(name)) { tokens[name] = ''; return; } // never declared: unresolved, not transparent
    const cs = getComputedStyle(cell);
    if (BACKGROUND_TOKENS.has(name)) {
      tokens[name] = cs.backgroundImage && cs.backgroundImage !== 'none' ? cs.backgroundImage : cs.backgroundColor;
    } else {
      tokens[name] = cs.color;
    }
  });
  probe.remove();
  return tokens;
}

const results = new Map();
const listeners = new Set();

export function checkTheme(themeId, { exempt = {}, mode } = {}) {
  const tokens = resolveThemeTokens(themeId, { mode });
  const result = { themeId, ...checkThemeTokens(tokens, { exempt }) };
  results.set(themeId, result);
  listeners.forEach((fn) => { try { fn(result); } catch (e) { /* one listener can't block others */ } });
  return result;
}

export function themeCheckResult(themeId) {
  return results.get(themeId) || null;
}

export function allThemeCheckResults() {
  return Array.from(results.values());
}

export function onThemeCheck(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Checks every theme in idle time, one per slice, the current one first.
// entries: [{ id, contrastExempt }] (themePackEntries()).
export function checkThemesWhenIdle(entries) {
  const current = document.documentElement.dataset.theme;
  const queue = [...entries].sort((a, b) => (a.id === current ? -1 : b.id === current ? 1 : 0));
  const idle = window.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 50));
  return new Promise((resolve) => {
    const step = () => {
      const next = queue.shift();
      if (!next) { resolve(allThemeCheckResults()); return; }
      try { checkTheme(next.id, { exempt: next.contrastExempt || {} }); } catch (e) { /* a broken theme stays unchecked */ }
      idle(step);
    };
    idle(step);
  });
}
