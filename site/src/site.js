// Shared data for the website: the repository and newest-release details the build looked up
// (vite.config.mjs defines __SITE_INFO__), the feature list, and the screenshots.
import features from './features.json';
import live from '@screenshots/live.jpg';
import guide from '@screenshots/guide.jpg';
import guideHd from '@screenshots/guide-hd.jpg';
import timeMachine from '@screenshots/time-machine.jpg';
import setup from '@screenshots/setup.png';

// { repoUrl, downloadUrl, releaseNote }, filled in by vite.config.mjs.
export const SITE = __SITE_INFO__;

// The feature pages in order: { slug, ch, title, summary }.
export const FEATURES = features;

// Screenshot URLs, bundled by Vite from docs/screenshots.
export const SHOTS = { live, guide, guideHd, timeMachine, setup };

/**
 * Builds a link to a file in the repository on GitHub.
 * @param {string} file The path inside the repository, e.g. "SECURITY.md".
 * @returns {string} The URL of that file on the master branch.
 */
export function repoFile(file) {
  return `${SITE.repoUrl}/blob/master/${file}`;
}

/**
 * Builds the in-site address of a feature page.
 * @param {string} slug The feature's slug from features.json.
 * @returns {string} The hash-route href.
 */
export function featureHref(slug) {
  return `#/features/${slug}`;
}
