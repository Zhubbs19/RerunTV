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

export function normalizeGuideGenre(value) {
  return String(value || '').trim().toLowerCase();
}

function hashHue(value) {
  let hash = 0;
  for (const char of value) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}

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

export function defaultGuideGenreColor(genre) {
  const key = normalizeGuideGenre(genre);
  return DEFAULT_GUIDE_GENRES[key] || hslToHex(hashHue(key), 58, 38);
}

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

export function guideGenreThemeConfig(config, themeId) {
  const entry = config?.display?.guideGenreStyles?.[themeId];
  return {
    enabled: entry?.enabled === true,
    colors: entry?.colors && typeof entry.colors === 'object' ? entry.colors : {},
  };
}

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
