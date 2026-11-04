// The landing page (#/): what RerunTV is, how channels work, a guide-style feature list linking
// to each feature page, screenshots, and links to the documentation.
import { FEATURES, SHOTS, SITE, featureHref, repoFile } from '../site.js';
import { Footer, Header } from '../components/Layout.jsx';

// The landing page's feature rows: [slug, short blurb]. Each links to its feature page.
const HIGHLIGHTS = [
  ['guide', 'A time-grid guide with a live “now” line, channel icons, filters, seven-day search and reminders that can tune the set for you.'],
  ['time-machine', 'Rewind or fast-forward the whole lineup, or jump to a date. Pick any show in the guide and it plays from its beginning.'],
  ['breaks', 'Bumpers and ad breaks from your own folders, timed per channel or per block, and moved to the fades to black where shows were cut for commercials.'],
  ['scheduling', 'Cartoons in the morning, something else overnight: schedule blocks swap a channel\'s folder by the hour, and holiday blocks take over for a date range.'],
  ['look', 'A mid-2000s cable-box layout in two skins, plus themes spanning decades of TV, CRT scanlines, channel-change static and a logo bug in the corner.'],
  ['library', 'A catalogue of your files, program details from .nfo files and tags, channel presets and smart channels built from a saved search.'],
  ['household', 'Per-person favorites, reminders and resume points, recordings from the guide, and a PIN parental lock.'],
  ['tv-mode', 'Run it full screen on a TV over HDMI with a remote, or pair a phone on the same Wi-Fi as a remote and setup screen.'],
];

const DOCS = [
  [`${SITE.repoUrl}/wiki`, 'User guide', 'Setting up channels, the remote and keyboard controls, breaks, themes and every setting.'],
  [`${SITE.repoUrl}#try-it-without-your-own-media`, 'Try the demo', 'A five-channel synthetic lineup to try RerunTV before pointing it at your own media.'],
  [repoFile('PLUGIN_DEVELOPMENT.md'), 'Plug-in guide', 'Write your own channels, overlays and media sources against the plug-in API.'],
  ['api/', 'Code reference', 'Every module, function and class, built from the comments in the source.'],
  [repoFile('CONTRIBUTING.md'), 'Contributing', 'Building from source, running the tests, and how the code is laid out.'],
  [repoFile('SECURITY.md'), 'Security', 'The threat model, the LAN pairing design, and how to report a problem.'],
];

const SCREENSHOTS = [
  [SHOTS.live, 'A channel playing, with the channel banner showing the program and time', 'Live TV with the channel banner'],
  [SHOTS.timeMachine, 'The time machine rewinding through a channel\'s schedule, with the programs on a strip below', 'The time machine'],
  [SHOTS.guideHd, 'The full-page program guide in the HD cable-box skin', 'The guide in the HD skin (the default)'],
  [SHOTS.setup, 'The channel setup screen, with the channel list and the selected channel\'s settings', 'Channel setup'],
];

/**
 * Renders the landing page.
 * @returns {JSX.Element} The page.
 */
export default function Home() {
  const bySlug = Object.fromEntries(FEATURES.map((page) => [page.slug, page]));
  const plugins = bySlug.plugins;
  return (
    <>
      <Header />
      <main id="main" tabIndex={-1}>
        <section className="hero">
          <div className="hero-text">
            <p className="eyebrow"><span className="ch">CH 03</span> Now airing</p>
            <h1>Your own media library, <em>on the air</em>.</h1>
            <p className="lede">RerunTV turns folders of your own video into cable channels. Each channel has been running since the moment you made it, so when you tune in, you land mid-show, with a program guide, commercial breaks and the look of an old cable box.</p>
            <div className="cta">
              <a className="button primary" href={SITE.downloadUrl}>Download for Windows</a>
              <a className="button" href={SITE.repoUrl}>View on GitHub</a>
            </div>
            <p className="fine">{SITE.releaseNote ? `${SITE.releaseNote} ` : ''}Beta software. The installer isn&apos;t code-signed yet, so Windows will warn you the first time; <a href={`${SITE.repoUrl}#download-and-install`}>here&apos;s how to check the download</a>. Free and open source (MIT).</p>
          </div>
          <figure className="tv">
            <div className="bezel">
              <img src={SHOTS.guide} alt="The RerunTV program guide in the Classic cable-box skin, with the live picture in the corner and a grid of channels and programs" width="1920" height="1080" />
            </div>
          </figure>
        </section>

        <section className="how" aria-labelledby="how-title">
          <h2 id="how-title">Channels are never restarted</h2>
          <div className="how-grid">
            <p>When you make a channel, it gets an anchor time. Whenever you tune in, RerunTV works out what would be playing right now if that folder had been looping ever since. Nothing runs in the background: it&apos;s arithmetic against the clock, so you can close the app for a week and the schedule is still right when you come back. <a href={featureHref('live-tv')}>More about live channels</a>.</p>
            <div className="loop" role="img" aria-label="A channel's loop of programs since its anchor time, with a marker where you tune in partway through a program">
              <div className="loop-row">
                <span>Ep. 1</span><span>Ad</span><span>Ep. 2</span><span>Ad</span><span className="here">Ep. 3</span><span>Ad</span><span>Ep. 4</span>
              </div>
              <div className="loop-labels">
                <span>Anchor time</span>
                <span className="now">You tune in here</span>
              </div>
            </div>
          </div>
        </section>

        <section id="features" className="features" aria-labelledby="features-title">
          <h2 id="features-title">What&apos;s on</h2>
          <div className="guide" role="list">
            <div className="guide-head" aria-hidden="true"><span>Channel</span><span>Program</span></div>
            {HIGHLIGHTS.map(([slug, blurb]) => (
              <div className="row" role="listitem" key={slug}>
                <div className="chan"><b>{bySlug[slug].ch}</b><a href={featureHref(slug)}>{bySlug[slug].title}</a></div>
                <p>{blurb}</p>
              </div>
            ))}
            <div className="row" role="listitem">
              <div className="chan"><b>{plugins.ch}</b><a href={featureHref('plugins')}>{plugins.title}</a></div>
              <p>Extra channels and overlays: a channel mosaic, local weather, captions, breaking-news overlays, metadata from TMDB or TVmaze, or <a href={repoFile('PLUGIN_DEVELOPMENT.md')}>write your own</a>.</p>
            </div>
          </div>
          <p className="all-features"><a className="button" href="#/features">All {FEATURES.length} features</a></p>
        </section>

        <section id="screenshots" className="shots" aria-labelledby="shots-title">
          <h2 id="shots-title">Screenshots</h2>
          <p className="sub">All from the bundled synthetic demo library. RerunTV ships no video; you bring your own.</p>
          <div className="shot-grid">
            {SCREENSHOTS.map(([src, alt, caption]) => (
              <figure key={caption}>
                <a href={src}><img src={src} alt={alt} loading="lazy" width="1920" height="1080" /></a>
                <figcaption>{caption}</figcaption>
              </figure>
            ))}
          </div>
        </section>

        <section id="docs" className="docs" aria-labelledby="docs-title">
          <h2 id="docs-title">Documentation</h2>
          <div className="cards">
            <a className="card" href="#/features">
              <h3>Features</h3>
              <p>A page for every part of RerunTV: the guide, breaks, scheduling, themes, the library and more.</p>
            </a>
            {DOCS.map(([href, title, text]) => (
              <a className="card" href={href} key={title}>
                <h3>{title}</h3>
                <p>{text}</p>
              </a>
            ))}
          </div>
        </section>

        <section className="notes" aria-label="Notices">
          <p><strong>Photosensitivity.</strong> RerunTV imitates old television, and some effects flicker or flash (scanline flicker, channel-change static, power animations, alert overlays). They can be turned down or off in Setup → Picture &amp; Sound and on the Plug-ins page. <a href={featureHref('look')}>More on comfort settings</a>.</p>
          <p><strong>How it&apos;s built.</strong> RerunTV was written almost entirely by an AI coding agent under the project owner&apos;s direction and hasn&apos;t had an independent code review or security audit. <a href={`${SITE.repoUrl}#how-this-project-is-built`}>More about that</a>.</p>
        </section>
      </main>
      <Footer />
    </>
  );
}
