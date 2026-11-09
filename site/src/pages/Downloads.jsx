// The downloads page (#/downloads): the newest release's files for each platform, how to check
// them, and the changelog (HELP > What's New, read at build time). The Linux card appears only
// when the release has an AppImage attached.
import { SITE } from '../site.js';
import { Footer, Header } from '../components/Layout.jsx';

// How many changelog dates show before the rest fold under "Older changes".
const OPEN_ENTRIES = 5;

/**
 * Formats a byte count for a download label.
 * @param {number} bytes The file's size.
 * @returns {string} The size in whole megabytes, e.g. "131 MB".
 */
function formatSize(bytes) {
  return `${Math.round(bytes / 1048576)} MB`;
}

/**
 * Formats a date for display, in UTC so a date-only value can't slip a day.
 * @param {string} value An ISO date, with or without a time.
 * @returns {string} The date, e.g. "November 6, 2026".
 */
function formatDate(value) {
  return new Date(value).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/**
 * One platform's download: its button, file details and notes.
 * @param {Object} props
 * @param {string} props.platform The platform's name.
 * @param {Object} props.file The release file: { name, url, size }.
 * @param {boolean} [props.primary=false] Whether this is the highlighted button.
 * @param {*} props.children Notes about this platform's download.
 * @returns {JSX.Element} The card.
 */
function DownloadCard({ platform, file, primary = false, children }) {
  return (
    <section className="dl-card" aria-label={platform}>
      <h2>{platform}</h2>
      <a className={primary ? 'button primary' : 'button'} href={file.url}>Download for {platform}</a>
      <p className="dl-file">{file.name} · {formatSize(file.size)}</p>
      {children}
    </section>
  );
}

/**
 * One date's changes in the changelog.
 * @param {Object} props
 * @param {Object} props.entry The entry: { date, items }.
 * @returns {JSX.Element} The entry.
 */
function ChangelogEntry({ entry }) {
  return (
    <article className="change">
      <h3><time dateTime={entry.date}>{formatDate(entry.date)}</time></h3>
      <ul>
        {entry.items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </article>
  );
}

/**
 * Renders the downloads page.
 * @returns {JSX.Element} The page.
 */
export default function Downloads() {
  const { release, changelog } = SITE;
  const recent = changelog.slice(0, OPEN_ENTRIES);
  const older = changelog.slice(OPEN_ENTRIES);
  return (
    <>
      <Header current="downloads" />
      <main id="main" className="article downloads" tabIndex={-1}>
        <header className="page-head">
          <p className="eyebrow"><span className="ch">CH 04</span> Downloads</p>
          <h1>Download RerunTV</h1>
          <p className="lede">{release ? `${release.tag}${release.beta ? ' (beta)' : ''}, released ${formatDate(release.date)}.` : 'Every build is on the Releases page.'} Free and open source (MIT).</p>
        </header>

        {release ? (
          <div className="dl-grid">
            <DownloadCard platform="Windows" file={release.windows} primary>
              <p>A 64-bit installer that keeps itself up to date. It isn&apos;t code-signed yet, so Windows will warn you the first time: choose <span className="menu-path">More info</span> and then <span className="menu-path">Run anyway</span>.</p>
            </DownloadCard>
            {release.linux ? (
              <DownloadCard platform="Linux" file={release.linux}>
                <p>An experimental 64-bit AppImage. Mark it executable and run it: <code>chmod +x {release.linux.name}</code></p>
                <p>It doesn&apos;t update itself, so come back here for new versions. Your channels are kept in <code>~/.config/RerunTV</code>. Install FFmpeg from your package manager for features that need it, such as converting files that won&apos;t play. Starting at sign-in is Windows-only for now.</p>
              </DownloadCard>
            ) : null}
          </div>
        ) : (
          <p><a className="button primary" href={SITE.releasesUrl}>Go to the Releases page</a></p>
        )}

        <section aria-labelledby="dl-more">
          <h2 id="dl-more">Before you install</h2>
          <ul>
            {release && release.checksums ? <li>Check your download against <a href={release.checksums.url}>SHA256SUMS.txt</a>, or <a href={`${SITE.repoUrl}#download-and-install`}>verify where it was built</a>.</li> : null}
            {release && release.demo ? <li>No media handy? <a href={release.demo.url}>The demo library</a> ({formatSize(release.demo.size)}) is a five-channel lineup to try first.</li> : null}
            <li>Older builds aren&apos;t kept: each new beta replaces the last. <a href={SITE.releasesUrl}>All releases</a>.</li>
          </ul>
        </section>

        <section aria-labelledby="changelog">
          <h2 id="changelog">Changelog</h2>
          {recent.map((entry) => <ChangelogEntry entry={entry} key={entry.date} />)}
          {older.length ? (
            <details className="older">
              <summary>Older changes</summary>
              {older.map((entry) => <ChangelogEntry entry={entry} key={entry.date} />)}
            </details>
          ) : null}
        </section>
      </main>
      <Footer />
    </>
  );
}
