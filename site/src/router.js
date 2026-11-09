// A tiny hash router for the website. GitHub Pages serves only files, so routes live after the
// "#": "#/" is the landing page, "#/features" the features index, "#/features/<slug>" a feature
// page, "#/downloads" the downloads and changelog, and "#/docs" or "#/screenshots" the landing page
// scrolled to that section.
import { useEffect, useState } from 'react';

/**
 * Splits a location hash into route parts.
 * @param {string} hash A location hash such as "#/features/guide".
 * @returns {string[]} The parts, e.g. ["features", "guide"]; [] for the landing page.
 */
export function parseHash(hash) {
  return hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
}

/**
 * Tracks the current route and updates when the hash changes.
 * @returns {string[]} The current route parts.
 */
export function useRoute() {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
