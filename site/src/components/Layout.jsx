// The website's shared frame: the header and footer on every page, and the feature-page layout
// with its channel-list sidebar, page heading and previous/next links.
import { FEATURES, SITE, featureHref } from '../site.js';

/**
 * Moves keyboard focus to the main content, for the skip link. A plain "#main" href would be
 * read as a route by the hash router, so this focuses the element instead.
 * @param {Event} event The click event.
 */
function skipToMain(event) {
  event.preventDefault();
  const main = document.getElementById('main');
  if (main) { main.focus(); main.scrollIntoView(); }
}

/**
 * The site header: the brand and the main navigation.
 * @param {Object} props
 * @param {string} [props.current] Which nav item is the current page ("features", "downloads" or none).
 * @returns {JSX.Element} The header.
 */
export function Header({ current }) {
  return (
    <>
      <a className="skip" href="#main" onClick={skipToMain}>Skip to content</a>
      <header className="top">
        <a className="brand" href="#/">
          <img src="icon.png" alt="" width="40" height="40" />
          <span>RerunTV</span>
        </a>
        <nav aria-label="Site">
          <a href="#/features" aria-current={current === 'features' ? 'page' : undefined}>Features</a>
          <a href="#/downloads" aria-current={current === 'downloads' ? 'page' : undefined}>Downloads</a>
          <a href="api/">Docs</a>
          <a href={SITE.repoUrl}>GitHub</a>
        </nav>
      </header>
    </>
  );
}

/**
 * The site footer: the license line.
 * @returns {JSX.Element} The footer.
 */
export function Footer() {
  return (
    <footer className="bottom">
      <span>RerunTV is MIT licensed. It isn&apos;t affiliated with any broadcaster, network or studio.</span>
      <a href={`${SITE.repoUrl}/blob/master/LICENSE`}>License</a>
    </footer>
  );
}

/**
 * The feature list down the side of a feature page, drawn as a guide's channel list.
 * @param {Object} props
 * @param {string|null} props.current The slug of the page being shown, or null on the index.
 * @returns {JSX.Element} The sidebar.
 */
function Sidebar({ current }) {
  return (
    <nav className="side" aria-label="Features">
      <a className="side-all" href="#/features" aria-current={current === null ? 'page' : undefined}>All features</a>
      <ol>
        {FEATURES.map((page) => (
          <li key={page.slug}>
            <a href={featureHref(page.slug)} aria-current={page.slug === current ? 'page' : undefined}>
              <b>{page.ch}</b><span>{page.title}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * The previous/next links at the foot of a feature page.
 * @param {Object} props
 * @param {string} props.slug The slug of the page being shown.
 * @returns {JSX.Element} The pager.
 */
function Pager({ slug }) {
  const index = FEATURES.findIndex((page) => page.slug === slug);
  const prev = FEATURES[index - 1];
  const next = FEATURES[index + 1];
  return (
    <nav className="pager" aria-label="More features">
      {prev ? (
        <a className="prev" href={featureHref(prev.slug)} rel="prev"><small>Previous · CH {prev.ch}</small>{prev.title}</a>
      ) : <span />}
      {next ? (
        <a className="next" href={featureHref(next.slug)} rel="next"><small>Next · CH {next.ch}</small>{next.title}</a>
      ) : <span />}
    </nav>
  );
}

/**
 * A feature page's frame: the sidebar, the heading with its channel number and summary, the
 * page's own sections, and the pager.
 * @param {Object} props
 * @param {Object} props.page The page's entry: { slug, ch, title, summary }, or one for the index.
 * @param {string} [props.eyebrow='Features'] The label beside the channel number.
 * @param {boolean} [props.isIndex=false] True on the features index (no pager, "All features" lit).
 * @param {*} props.children The page's sections.
 * @returns {JSX.Element} The page.
 */
export function FeatureLayout({ page, eyebrow = 'Features', isIndex = false, children }) {
  return (
    <>
      <Header current="features" />
      <div className="doc">
        <Sidebar current={isIndex ? null : page.slug} />
        <main id="main" className="article" tabIndex={-1}>
          <header className="page-head">
            <p className="eyebrow"><span className="ch">CH {page.ch}</span> {eyebrow}</p>
            <h1>{page.title}</h1>
            <p className="lede">{page.summary}</p>
          </header>
          {children}
          {isIndex ? null : <Pager slug={page.slug} />}
        </main>
      </div>
      <Footer />
    </>
  );
}

/**
 * A screenshot that opens full size when clicked.
 * @param {Object} props
 * @param {string} props.src The image URL (from SHOTS).
 * @param {string} props.alt What the screenshot shows.
 * @param {string} props.caption The caption under it.
 * @returns {JSX.Element} The figure.
 */
export function Shot({ src, alt, caption }) {
  return (
    <figure className="shot">
      <a href={src}><img src={src} alt={alt} width="1920" height="1080" /></a>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
