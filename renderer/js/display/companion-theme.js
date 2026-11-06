// What the phone companion (companion-rn) is told about the box theme, so its
// colours can follow it. Rides on the remote-state push as `theme` (power.js's
// pushRemoteState), which the companion-app plugin serves on GET /state.
// The phone derives its whole palette from these few semantic tokens
// (tokens.css, docs/design/04), so no table of theme ids is needed on either
// side. Pure, so the unit tests can run it.

// The semantic tokens sent, by name without the leading `--`. Every pack sets
// most of them; the phone derives whatever is missing.
export const COMPANION_THEME_TOKENS = Object.freeze([
  'surface-0', 'surface-1', 'surface-2', 'surface-3',
  'text', 'text-muted', 'border',
  'accent', 'accent-text', 'accent-2', 'danger',
  'control-bg', 'control-text', 'selected-bg', 'selected-text',
]);

const HEX = /#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/i;
const RGB = /rgba?\(\s*[\d.]+[\s,]+[\d.]+[\s,]+[\d.]+\s*(?:[,/]\s*[\d.]+%?\s*)?\)/i;

/**
 * Whether an rgb()/rgba() colour is fully opaque.
 * @param {string} text The colour.
 * @returns {boolean} True unless it gives an alpha below 1.
 */
function isOpaque(text) {
  const parts = text.slice(text.indexOf('(') + 1, -1).split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 4) return true;
  const alpha = parts[3].endsWith('%') ? Number(parts[3].slice(0, -1)) / 100 : Number(parts[3]);
  return alpha >= 1;
}

/**
 * Reduces a token value to one solid colour the phone can paint.
 * A plain colour is kept; a gradient gives its first colour stop (control and
 * selected backgrounds are often gradients). Anything else is dropped.
 * @param {*} value The token's computed value.
 * @returns {?string} A `#hex` or opaque `rgb()` colour, or null.
 */
export function solidColor(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 400) return null;
  const isGradient = /gradient\(/i.test(text);
  if (!isGradient && !(HEX.test(text) || RGB.test(text))) return null;
  const hex = text.match(HEX);
  const rgb = text.match(RGB);
  // The earlier of the two, so a gradient's first stop wins whatever its notation.
  const first = [hex, rgb].filter(Boolean).sort((a, b) => a.index - b.index)[0];
  if (!first) return null;
  if (!isGradient && first[0].length !== text.length) return null; // `#fff extra` is not a colour
  const color = first[0].toLowerCase();
  return color.startsWith('rgb') && !isOpaque(color) ? null : color;
}

/**
 * Builds the `theme` report for the phone.
 * Colours are read only while the box theme itself is painted. On the legacy
 * layout a channel's identity theme can be painted instead; then the last
 * colours read for this box theme are kept, so the phone does not change
 * colour with every channel.
 * @param {object} opts The current theme state.
 * @param {?string} opts.boxThemeId The box theme (the household profile's, if it sets one).
 * @param {?string} opts.paintedThemeId The theme painted on screen now.
 * @param {string} opts.uiMode The on-screen layout, 'cable-guide' or 'legacy'.
 * @param {?string} [opts.label] The box theme's display name.
 * @param {Function} opts.readVar Returns a custom property's computed value, given `--name`.
 * @param {?object} [opts.previous] The last report, to keep while another theme is painted.
 * @returns {?object} `{ id, ui, label, colors }`, colors null when not known yet; null without a box theme.
 */
export function companionThemeReport({ boxThemeId, paintedThemeId, uiMode, label = null, readVar, previous = null }) {
  if (!boxThemeId) return null;
  const ui = uiMode === 'cable-guide' ? 'cable-guide' : 'legacy';
  const base = { id: boxThemeId, ui, label: typeof label === 'string' ? label : null };
  if (paintedThemeId !== boxThemeId || typeof readVar !== 'function') {
    const kept = previous && previous.id === boxThemeId ? previous.colors : null;
    return { ...base, colors: kept || null };
  }
  const colors = {};
  COMPANION_THEME_TOKENS.forEach((name) => {
    const value = solidColor(readVar(`--${name}`));
    if (value) colors[name] = value;
  });
  return { ...base, colors: Object.keys(colors).length ? colors : null };
}
