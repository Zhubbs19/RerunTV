// Colour parsing and WCAG contrast (docs/design/04 §4.4). Pure: no DOM, so the
// theme check, its unit tests and the contrast drivers in tests/ui/ share one
// implementation.
//
// It reads what CSS hands back: hex, rgb()/rgba() in comma or space syntax,
// hsl(), a few names, transparent, and color(srgb r g b / a), which is what a
// computed color-mix() serializes to (older checkers couldn't read that and
// passed it silently). color-mix(in srgb, …) is also computed here directly,
// for token values that haven't been through a browser. Gradients are never
// "unknown": every colour stop is a background candidate, and the worst one
// counts.

const NAMED = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], lime: [0, 255, 0], green: [0, 128, 0],
  blue: [0, 0, 255], yellow: [255, 255, 0], cyan: [0, 255, 255], aqua: [0, 255, 255], magenta: [255, 0, 255],
  fuchsia: [255, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192],
  navy: [0, 0, 128], teal: [0, 128, 128], maroon: [128, 0, 0], olive: [128, 128, 0], purple: [128, 0, 128],
  orange: [255, 165, 0], gold: [255, 215, 0],
};

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

// Splits on a separator that isn't inside parentheses.
export function splitTopLevel(text, separator = ',') {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of String(text)) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === separator && depth === 0) { parts.push(current.trim()); current = ''; } else current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function channel(token, scale) {
  const text = String(token).trim();
  if (text.endsWith('%')) return (parseFloat(text) / 100) * scale;
  return parseFloat(text);
}

function alphaOf(token) {
  if (token === undefined || token === '') return 1;
  const text = String(token).trim();
  const value = text.endsWith('%') ? parseFloat(text) / 100 : parseFloat(text);
  return Number.isFinite(value) ? clamp(value, 0, 1) : 1;
}

// Channel list of rgb()/hsl()/color(): "1, 2, 3, .5" or "1 2 3 / 50%".
function channelList(body) {
  const [main, slashAlpha] = body.split('/');
  const parts = main.split(/[\s,]+/).filter(Boolean);
  const alpha = slashAlpha !== undefined ? slashAlpha.trim() : parts[3];
  return { parts: parts.slice(0, 3), alpha };
}

function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

// Returns { r, g, b, a } (r/g/b 0–255, a 0–1) or null when it isn't a colour.
export function parseColor(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (!text) return null;
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (NAMED[text]) { const [r, g, b] = NAMED[text]; return { r, g, b, a: 1 }; }
  if (text[0] === '#') {
    let hex = text.slice(1);
    if (!/^[0-9a-f]+$/.test(hex) || ![3, 4, 6, 8].includes(hex.length)) return null;
    if (hex.length <= 4) hex = hex.split('').map((c) => c + c).join('');
    const n = (i) => parseInt(hex.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 };
  }
  let m = text.match(/^rgba?\((.*)\)$/);
  if (m) {
    const { parts, alpha } = channelList(m[1]);
    if (parts.length < 3) return null;
    const [r, g, b] = parts.map((p) => clamp(channel(p, 255), 0, 255));
    if (![r, g, b].every(Number.isFinite)) return null;
    return { r, g, b, a: alphaOf(alpha) };
  }
  m = text.match(/^hsla?\((.*)\)$/);
  if (m) {
    const { parts, alpha } = channelList(m[1]);
    if (parts.length < 3) return null;
    const h = parseFloat(parts[0]);
    const s = parseFloat(parts[1]) / 100;
    const l = parseFloat(parts[2]) / 100;
    if (![h, s, l].every(Number.isFinite)) return null;
    const [r, g, b] = hslToRgb(((h % 360) + 360) % 360, clamp(s, 0, 1), clamp(l, 0, 1));
    return { r, g, b, a: alphaOf(alpha) };
  }
  // color(srgb 0.1 0.2 0.3 / 0.5): what a computed color-mix() becomes.
  m = text.match(/^color\(\s*srgb\s+(.*)\)$/);
  if (m) {
    const { parts, alpha } = channelList(m[1]);
    if (parts.length < 3) return null;
    const [r, g, b] = parts.map((p) => clamp(channel(p, 1), 0, 1) * 255);
    if (![r, g, b].every(Number.isFinite)) return null;
    return { r, g, b, a: alphaOf(alpha) };
  }
  if (text.startsWith('color-mix(')) return parseColorMix(text);
  return null;
}

// color-mix(in srgb, A p%, B q%) with the spec's percentage normalization and
// premultiplied alpha. Other interpolation spaces are approximated in sRGB.
export function parseColorMix(value) {
  const m = String(value).trim().toLowerCase().match(/^color-mix\((.*)\)$/);
  if (!m) return null;
  const args = splitTopLevel(m[1]);
  if (args.length !== 3 || !args[0].startsWith('in ')) return null;
  const side = (arg) => {
    const pct = arg.match(/\s(-?[\d.]+)%$/);
    const colorText = pct ? arg.slice(0, pct.index) : arg;
    return { color: parseColor(colorText), pct: pct ? parseFloat(pct[1]) / 100 : null };
  };
  const a = side(args[1]);
  const b = side(args[2]);
  if (!a.color || !b.color) return null;
  let p1 = a.pct;
  let p2 = b.pct;
  if (p1 === null && p2 === null) { p1 = 0.5; p2 = 0.5; } else if (p1 === null) p1 = 1 - p2; else if (p2 === null) p2 = 1 - p1;
  const sum = p1 + p2;
  if (sum <= 0) return null;
  const scale = sum < 1 ? sum : 1; // under 100% total lowers the alpha
  p1 /= sum;
  p2 /= sum;
  const alpha = a.color.a * p1 + b.color.a * p2;
  const mix = (k) => (alpha > 0 ? (a.color[k] * a.color.a * p1 + b.color[k] * b.color.a * p2) / alpha : 0);
  return { r: mix('r'), g: mix('g'), b: mix('b'), a: alpha * scale };
}

// The colours in a gradient, in order. Stop positions are ignored: the worst
// stop is what the check needs, and every stop is somewhere on screen.
export function gradientStops(value) {
  const m = String(value).trim().match(/^(?:repeating-)?(?:linear|radial|conic)-gradient\((.*)\)$/i);
  if (!m) return null;
  const stops = [];
  splitTopLevel(m[1]).forEach((arg) => {
    // A colour stop may be followed by one or two positions; the first
    // argument may instead be a direction/shape with no colour at all.
    const words = splitTopLevel(arg, ' ');
    for (let i = words.length; i >= 1; i -= 1) {
      const color = parseColor(words.slice(0, i).join(' '));
      if (color) { stops.push(color); return; }
    }
  });
  return stops;
}

// A background value (a colour, a gradient, or comma-separated layers, top
// first) as a list of layers, each a list of candidate colours.
export function backgroundLayers(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text === 'none') return [];
  const layers = [];
  splitTopLevel(text).forEach((part) => {
    const stops = gradientStops(part);
    if (stops) { if (stops.length) layers.push(stops); return; }
    const color = parseColor(part);
    if (color) layers.push([color]);
  });
  return layers;
}

// fg drawn over an opaque bg.
export function composite(fg, bg) {
  const a = fg.a;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
}

// Flattens layers (top first) over opaque base candidates into every opaque
// colour that can show through, deduplicated.
export function flattenLayers(layers, base = [{ r: 0, g: 0, b: 0, a: 1 }]) {
  let candidates = base.map((c) => (c.a >= 1 ? c : composite(c, { r: 0, g: 0, b: 0, a: 1 })));
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const next = new Map();
    layers[i].forEach((stop) => candidates.forEach((under) => {
      const c = composite(stop, under);
      next.set(`${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)}`, c);
    }));
    candidates = Array.from(next.values());
  }
  return candidates;
}

export function relativeLuminance({ r, g, b }) {
  const f = (x) => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(a, b) {
  const x = relativeLuminance(a);
  const y = relativeLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// The lowest ratio of fg (which may be translucent) against any background
// candidate. Returns { ratio, fg, bg } for the worst pairing.
export function worstContrast(fg, backgrounds) {
  let worst = null;
  backgrounds.forEach((bg) => {
    const shown = composite(fg, bg);
    const ratio = contrastRatio(shown, bg);
    if (!worst || ratio < worst.ratio) worst = { ratio, fg: shown, bg };
  });
  return worst;
}

export function toHex({ r, g, b }) {
  return `#${[r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
}
