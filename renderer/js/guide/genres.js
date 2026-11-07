// Pure guide-genre palette helpers shared by the guide renderer and Display
// settings. Palettes are stored per theme so light and dark skins can be
// tuned independently.
export const DEFAULT_GUIDE_GENRES = Object.freeze({
  movie: '#6d5bd0',
  news: '#c62828',
  sports: '#15803d',
  kids: '#f59e0b',
  comedy: '#db2777',
  drama: '#7c3aed',
  documentary: '#0f766e',
  reality: '#ea580c',
  music: '#2563eb',
  educational: '#0891b2',
});

/**
 * Normalizes a genre name for lookup.
 * @param {*} value A genre name.
 * @returns {string} The trimmed, lower-cased name.
 */
export function normalizeGuideGenre(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Hashes a string to a stable hue.
 * @param {string} value The text to hash.
 * @returns {number} A hue in 0..359.
 */
function hashHue(value) {
  let hash = 0;
  for (const char of value) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}

/**
 * Converts an HSL colour to a hex string.
 * @param {number} h Hue in degrees, 0..359.
 * @param {number} s Saturation in percent.
 * @param {number} l Lightness in percent.
 * @returns {string} A `#rrggbb` colour.
 */
function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  const rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180
    ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + rgb.map((part) => Math.round((part + m) * 255).toString(16).padStart(2, '0')).join('');
}

/**
 * Returns the default colour for a genre.
 * Known genres use the built-in palette; others get a stable colour from their name.
 * @param {string} genre The genre name.
 * @returns {string} A `#rrggbb` colour.
 */
export function defaultGuideGenreColor(genre) {
  const key = normalizeGuideGenre(genre);
  return DEFAULT_GUIDE_GENRES[key] || hslToHex(hashHue(key), 58, 38);
}

/**
 * Picks dark or white text for a genre background by its luminance.
 * @param {string} background A `#rrggbb` colour.
 * @returns {string} A `#rrggbb` text colour; white when the input is not a hex colour.
 */
export function guideGenreTextColor(background) {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(background || '');
  if (!match) return '#ffffff';
  const linear = match.slice(1).map((part) => {
    const value = parseInt(part, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  return luminance > 0.42 ? '#10131a' : '#ffffff';
}

/**
 * Reads a theme's genre-colour settings.
 * @param {object} config The box config.
 * @param {string} themeId The theme id.
 * @returns {object} `{ enabled, colors }`, where `colors` maps genre to colour.
 */
export function guideGenreThemeConfig(config, themeId) {
  const entry = config?.display?.guideGenreStyles?.[themeId];
  return {
    enabled: entry?.enabled === true,
    colors: entry?.colors && typeof entry.colors === 'object' ? entry.colors : {},
  };
}

/**
 * Returns the genre colours for a file's guide cell under a theme.
 * @param {object} file The channel file.
 * @param {object} config The box config.
 * @param {string} themeId The theme id.
 * @returns {?object} `{ key, background, foreground }`, or `null` when genre colours are off or the file has no genre.
 */
export function guideGenreStyleForFile(file, config, themeId) {
  const themeConfig = guideGenreThemeConfig(config, themeId);
  if (!themeConfig.enabled) return null;
  const genres = Array.isArray(file?.facets?.genre) ? file.facets.genre : [];
  const key = genres.map(normalizeGuideGenre).find(Boolean);
  if (!key) return null;
  const custom = themeConfig.colors[key];
  const background = /^#[\da-f]{6}$/i.test(custom || '') ? custom : defaultGuideGenreColor(key);
  return { key, background, foreground: guideGenreTextColor(background) };
}
