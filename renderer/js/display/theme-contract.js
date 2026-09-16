// The theme pack CSS contract (docs/design/04 §4.1). Pure, so the unit tests
// and Plug-ins › Diagnostics can both check a pack against it.
//
// A theme pack's style.css may contain only:
//   1. token blocks — html[data-theme="id"] (optionally [data-mode="tv"]) with
//      custom properties only, and never a density token;
//   2. slot decorations — html[data-theme="id"] [data-slot="name"] (a :is() list
//      of slots, ::before/::after allowed) setting decoration properties only:
//      colours, backgrounds, borders, radii, shadows, type, spacing, animation —
//      never position, size, display or stacking;
//   3. native field chrome — html[data-theme="id"] :is(input, select, textarea)
//      and its :focus/:focus-visible, same property list;
//   4. @keyframes, and @media (prefers-reduced-motion) around rules of kind 2–3.

// Every element a theme may decorate, and where it is.
export const THEME_SLOTS = Object.freeze({
  'guide-grid': 'the program guide panel',
  'guide-topbar': 'the guide header (selected program facts)',
  'guide-info-number': 'channel number in the guide header',
  'guide-info-title': 'program title in the guide header',
  'guide-info-body': 'text column in the guide header',
  'guide-timeheader': 'the half-hour time bar',
  'guide-rail': 'a row\'s channel cell',
  'guide-rail-number': 'channel number in a rail cell',
  'guide-rail-name': 'channel name in a rail cell',
  'guide-track': 'a row\'s program track',
  'guide-cell': 'a program cell',
  'guide-gridlines': 'the half-hour rules behind the cells',
  'guide-now-line': 'the current-time line',
  'guide-hint': 'the guide\'s key hints',
  'guide-banner': 'the channel / now-playing card',
  'guide-banner-number': 'channel number on the card',
  'guide-banner-name': 'channel name on the card',
  'guide-progress': 'the card\'s progress bar track',
  'guide-progress-fill': 'the card\'s progress bar fill',
  'channel-entry': 'digits typed on the remote',
  'hint-bar': 'the live-TV key hint bar',
  'rating-bug': 'the content rating card',
  'volume-indicator': 'the volume card',
  'volume-bar': 'the volume track',
  'volume-bar-fill': 'the volume fill',
  'tv-menu-button': 'a TV menu button',
  'power-fx': 'the power on/off line',
});

export const SLOT_DECORATION_PROPERTIES = Object.freeze(new Set([
  'color', 'background', 'background-color', 'background-image', 'background-size', 'background-position', 'background-repeat', 'background-blend-mode',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-color', 'border-style', 'border-width',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-image',
  'border-radius', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius',
  'box-shadow', 'text-shadow', 'outline', 'outline-color', 'outline-offset', 'outline-style', 'outline-width',
  'font', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'font-variant-numeric', 'letter-spacing', 'line-height', 'text-transform', 'text-decoration', 'text-align', 'word-spacing',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'padding-block', 'padding-inline',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'margin-block', 'margin-inline',
  'gap', 'opacity', 'filter', 'backdrop-filter', 'mix-blend-mode', 'image-rendering', 'transform', 'transform-origin',
  'animation', 'animation-name', 'animation-duration', 'animation-timing-function', 'animation-delay', 'animation-iteration-count', 'animation-direction', 'animation-fill-mode',
  'transition', 'transition-duration', 'transition-timing-function', 'caret-color', 'accent-color', 'content',
]));

// Theme-facing density is core's (§4.3).
export const DENSITY_TOKENS = Object.freeze(new Set([
  '--density', '--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6',
  '--control-h', '--target-min', '--font-size-body', '--font-size-label', '--safe-x', '--safe-y',
]));

function stripComments(css) {
  return String(css).replace(/\/\*[\s\S]*?\*\//g, '');
}

function declarations(body) {
  return body.split(/;(?![^(]*\))/).map((d) => d.trim()).filter(Boolean).map((d) => {
    const at = d.indexOf(':');
    return at === -1 ? { name: d, value: '' } : { name: d.slice(0, at).trim().toLowerCase(), value: d.slice(at + 1).trim() };
  });
}

// Top-level blocks with their at-rule context: [{ at: ['@media …'], selector, body }].
function blocks(css) {
  const out = [];
  const stack = [];
  let i = 0;
  let prelude = '';
  while (i < css.length) {
    const ch = css[i];
    if (ch === '{') {
      const sel = prelude.trim();
      prelude = '';
      if (sel.startsWith('@')) { stack.push(sel); i += 1; continue; }
      const end = css.indexOf('}', i);
      out.push({ at: stack.slice(), selector: sel, body: css.slice(i + 1, end === -1 ? css.length : end) });
      i = end === -1 ? css.length : end + 1;
      continue;
    }
    if (ch === '}') { stack.pop(); prelude = ''; i += 1; continue; }
    prelude += ch;
    i += 1;
  }
  return out;
}

function splitSelectors(selector) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of selector) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; } else current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// Returns [{ selector, problem }]; empty when the CSS keeps the contract.
export function lintThemeCss(themeId, cssText) {
  const problems = [];
  const root = `html[data-theme="${themeId}"]`;
  const rootRe = `html\\[data-theme="${themeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\](?:\\[data-mode="tv"\\])?`;
  const slotName = '\\[data-slot="([a-z0-9-]+)"\\]';
  const slotRe = new RegExp(`^${rootRe} (?:${slotName}|:is\\((${slotName}(?:\\s*,\\s*${slotName})*)\\))(?:::before|::after)?$`);
  const fieldRe = new RegExp(`^${rootRe} (?::is\\(\\s*input\\s*,\\s*select\\s*,\\s*textarea\\s*\\)|input|select|textarea)(?::focus|:focus-visible)?$`);
  const tokenRe = new RegExp(`^${rootRe}$`);

  for (const block of blocks(stripComments(cssText))) {
    const inKeyframes = block.at.some((a) => /^@(-webkit-)?keyframes\b/.test(a));
    if (inKeyframes) continue;
    const badAt = block.at.find((a) => !/^@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)$/.test(a));
    if (badAt) { problems.push({ selector: block.selector, problem: `inside unsupported ${badAt}` }); continue; }
    const decls = declarations(block.body);
    const selectors = splitSelectors(block.selector);
    for (const sel of selectors) {
      if (tokenRe.test(sel)) {
        if (block.at.length) { problems.push({ selector: sel, problem: 'token block inside @media' }); continue; }
        decls.forEach((d) => {
          if (!d.name.startsWith('--')) problems.push({ selector: sel, problem: `${d.name} in a token block (tokens only)` });
          else if (DENSITY_TOKENS.has(d.name)) problems.push({ selector: sel, problem: `${d.name} is density; themes never set it` });
        });
        continue;
      }
      const slot = sel.match(slotRe);
      const field = !slot && fieldRe.test(sel);
      if (!slot && !field) {
        problems.push({ selector: sel, problem: sel.startsWith(root) ? 'not a token block, slot or field selector' : `not scoped to ${root}` });
        continue;
      }
      if (slot) {
        const names = [...sel.matchAll(/\[data-slot="([a-z0-9-]+)"\]/g)].map((m) => m[1]);
        names.filter((n) => !(n in THEME_SLOTS)).forEach((n) => problems.push({ selector: sel, problem: `unknown slot "${n}"` }));
      }
      decls.forEach((d) => {
        if (d.name.startsWith('--')) problems.push({ selector: sel, problem: `${d.name}: set tokens in the token block` });
        else if (!SLOT_DECORATION_PROPERTIES.has(d.name)) problems.push({ selector: sel, problem: `${d.name} changes layout or state; not a decoration` });
      });
    }
  }
  return problems;
}
