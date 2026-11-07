// The cable-guide UI's small icon set: square tiles on program info and the
// Quick Menu. 20×20 SVG paths; class cg-icon-rec paints in the record red.

// SVG path markup for each icon name.
export const ICONS = Object.freeze({
  back: '<path d="M8 4 2 10l6 6v-4h10V8H8z"/>',
  play: '<path d="M5 3v14l12-7z"/>',
  start: '<path d="M3 3h2v14H3zM18 3v14L7 10z"/>',
  info: '<path d="M9 8h2v8H9zm0-4h2v2H9z"/><path d="M10 1a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 16a7 7 0 1 1 0-14 7 7 0 0 1 0 14z"/>',
  record: '<circle cx="10" cy="10" r="6" class="cg-icon-rec"/>',
  series: '<circle cx="7" cy="10" r="4.5" class="cg-icon-rec"/><circle cx="14" cy="10" r="4.5" class="cg-icon-rec"/>',
  remind: '<path d="M10 19a2 2 0 0 0 2-2H8a2 2 0 0 0 2 2zm6-5V9a6 6 0 0 0-4.5-5.8V2.5a1.5 1.5 0 0 0-3 0v.7A6 6 0 0 0 4 9v5l-2 2v1h16v-1z"/>',
  list: '<path d="M3 4h14v2H3zm0 5h14v2H3zm0 5h14v2H3z"/>',
  'day-back': '<path d="M12 4 6 10l6 6V4z"/><path d="M15 4h2v12h-2z"/>',
  'day-ahead': '<path d="M8 4l6 6-6 6V4z"/><path d="M3 4h2v12H3z"/>',
  menu: '<path d="M2 3h7v6H2zm9 0h7v6h-7zM2 11h7v6H2zm9 0h7v6h-7z"/>',
  favorite: '<path d="M10 18 8.6 16.7C3.4 12 0 9 0 5.3 0 2.3 2.4 0 5.5 0 7.2 0 8.9.8 10 2.1 11.1.8 12.8 0 14.5 0 17.6 0 20 2.3 20 5.3c0 3.7-3.4 6.7-8.6 11.4z" transform="scale(.9) translate(1.1 1.5)"/>',
  lock: '<path d="M15 8h-1V6a4 4 0 0 0-8 0v2H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1zM8 6a2 2 0 0 1 4 0v2H8z"/>',
  mark: '<path d="M5 2h10v16l-5-4-5 4z"/>',
  home: '<path d="M10 2 1 10h3v8h5v-5h2v5h5v-8h3z"/>',
  guide: '<path d="M1 3h5v3H1zm6 0h12v3H7zM1 8.5h5v3H1zm6 0h7v3H7zm8 0h4v3h-4zM1 14h5v3H1zm6 0h12v3H7z"/>',
  search: '<path d="M8 2a6 6 0 0 1 4.9 9.5l5 5-1.4 1.4-5-5A6 6 0 1 1 8 2zm0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/>',
  clock: '<path d="M10 1a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 16a7 7 0 1 1 0-14 7 7 0 0 1 0 14zm.5-11H9v5.2l4.5 2.7.8-1.2-3.8-2.3z"/>',
  recent: '<path d="M10 2a8 8 0 1 1-7.4 5h2.2A6 6 0 1 0 10 4v3L5.5 3.5 10 0z"/><path d="M9 6h2v4.4l3 1.8-1 1.7-4-2.4z"/>',
  skip: '<path d="M2 4l8 6-8 6zm8 0 8 6-8 6z"/>',
  audio: '<path d="M2 7h4l5-4v14l-5-4H2zm11.5-.5a5 5 0 0 1 0 7l-1.4-1.4a3 3 0 0 0 0-4.2zm2.8-2.8a9 9 0 0 1 0 12.6l-1.4-1.4a7 7 0 0 0 0-9.8z"/>',
});

/**
 * Builds an icon's SVG markup.
 * @param {string} name The icon name, a key of `ICONS`.
 * @returns {string} The SVG markup, or '' for an unknown name.
 */
export function iconSvg(name) {
  return ICONS[name] ? `<svg viewBox="0 0 20 20" aria-hidden="true">${ICONS[name]}</svg>` : '';
}
