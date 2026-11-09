// The website's top-level component: picks the page for the current #/ route, sets the window
// title, and scrolls to the top (or to a landing-page section) when the route changes.
import { useEffect } from 'react';
import { useRoute } from './router.js';
import { FEATURES } from './site.js';
import { FeatureLayout } from './components/Layout.jsx';
import Home from './pages/Home.jsx';
import FeaturesIndex from './pages/FeaturesIndex.jsx';
import Downloads from './pages/Downloads.jsx';

// Each feature page's component, keyed by slug: pages/features/<slug>.jsx.
const FEATURE_PAGES = Object.fromEntries(
  Object.entries(import.meta.glob('./pages/features/*.jsx', { eager: true, import: 'default' }))
    .map(([file, component]) => [file.match(/([^/]+)\.jsx$/)[1], component]),
);

// Landing-page sections that have a route of their own (#/docs scrolls to id="docs").
const HOME_SECTIONS = new Set(['docs', 'screenshots']);

/**
 * Renders the page for the current route.
 * @returns {JSX.Element} The page.
 */
export default function App() {
  const route = useRoute();
  const [first, second] = route;
  const feature = first === 'features' && second ? FEATURES.find((page) => page.slug === second) : null;
  const FeaturePage = feature && FEATURE_PAGES[feature.slug];
  const isHome = route.length === 0 || (route.length === 1 && HOME_SECTIONS.has(first));
  const isIndex = route.length === 1 && first === 'features';
  const isDownloads = route.length === 1 && first === 'downloads';

  let title = 'RerunTV';
  if (FeaturePage) title = `${feature.title} · RerunTV`;
  else if (isIndex) title = 'Features · RerunTV';
  else if (isDownloads) title = 'Downloads · RerunTV';
  else if (!isHome) title = 'Not found · RerunTV';

  useEffect(() => {
    document.title = title;
    const section = isHome && first ? document.getElementById(first) : null;
    // Instant, not the stylesheet's smooth scrolling: a new page should open at its top.
    if (section) section.scrollIntoView({ behavior: 'instant' });
    else window.scrollTo({ top: 0, behavior: 'instant' });
  }, [title, isHome, first, route.length]);

  if (FeaturePage) return <FeaturePage />;
  if (isIndex) return <FeaturesIndex />;
  if (isDownloads) return <Downloads />;
  if (isHome) return <Home />;
  return (
    <FeatureLayout page={{ slug: '', ch: '00', title: 'No signal', summary: 'There is no page at this address.' }} eyebrow="Not found" isIndex>
      <section>
        <p>Try the <a href="#/features">list of features</a> or go back to the <a href="#/">front page</a>.</p>
      </section>
    </FeatureLayout>
  );
}
