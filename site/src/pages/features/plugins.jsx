// The Plug-ins feature page (#/features/plugins).
import { FEATURES, featureHref, repoFile } from '../../site.js';
import { FeatureLayout } from '../../components/Layout.jsx';

const PAGE = FEATURES.find((page) => page.slug === 'plugins');

// First-party on-screen plug-ins: [name, what it does].
const OVERLAYS = [
  ['Closed captions', 'Real captions from a .srt or .vtt file beside the video, or a subtitle stream inside it, styled to suit the theme. K turns them on and off.'],
  ['Breaking news', 'Random or on-demand news bulletins in four styles, with your own headlines and a spoken readout. Press B.'],
  ['Emergency alerts', 'A full-screen alert with an attention tone and slate, as a periodic test or from real weather alerts for your area. Press E to test.'],
  ['Text ticker', 'A scrolling strip along the bottom of the screen.'],
  ['Test pattern', 'Color bars instead of a plain "no signal" card on an empty channel number.'],
  ['Screensaver', 'An idle-state overlay after a while with no input, in the style of the theme.'],
  ['Sponsor billboard', 'A "brought to you by" card, once per airing, on channels with a sponsor set.'],
  ['Reel-change marks', 'The projectionist\'s cue dot in the corner of a film, every twenty minutes or so.'],
  ['Signal glitches', 'Rare, brief bursts of static, like an antenna having a bad day.'],
  ['Vintage audio', 'Tape hiss, console hum or carrier tone, depending on the theme.'],
];

/**
 * Renders the Plug-ins page.
 * @returns {JSX.Element} The page.
 */
export default function PluginsPage() {
  return (
    <FeatureLayout page={PAGE}>
      <section>
        <h2>Much of the box is plug-ins</h2>
        <p>The <a href={featureHref('channels')}>built-in channels</a>, the phone remote, weather and program-detail lookups, captions and alerts are all plug-ins, listed on the plug-ins page of setup. Some come switched on; you can switch any of them off, and add more yourself.</p>
        <ul>
          <li><strong>Install</strong> with <span className="menu-path">Install from zip…</span>, or drop a plug-in&apos;s folder into the plugins folder and choose <span className="menu-path">Rescan</span>.</li>
          <li><strong>Switch on or off</strong> with the checkbox beside each one, then save. Most changes take effect after a restart.</li>
          <li><strong>Remove</strong> one you installed by deleting its folder. Built-in plug-ins that a later update drops clean up after themselves.</li>
          <li><strong>Settings</strong> for each plug-in sit on the same page, beside it.</li>
        </ul>
      </section>

      <section>
        <h2>On-screen extras</h2>
        <div className="table-wrap">
          <table className="keys">
            <thead><tr><th scope="col">Plug-in</th><th scope="col">What it does</th></tr></thead>
            <tbody>
              {OVERLAYS.map(([name, what]) => (
                <tr key={name}><th scope="row">{name}</th><td>{what}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>Others add <a href={featureHref('program-details')}>program details from TMDB and TVmaze</a>, <a href={featureHref('other-screens')}>a phone remote and casting</a>, and <a href={featureHref('library')}>codec conversion with FFmpeg</a>.</p>
      </section>

      <section>
        <h2>What a plug-in is allowed to do</h2>
        <p>Some plug-ins need extra permissions: to reach the internet, open another program, or serve their own page on your network. Each one lists exactly what it needs and why, in plain language, and asks for your approval before its first use. If an update adds a permission, it asks again.</p>
        <p>Many plug-ins also run in a walled-off process of their own, much as each browser tab does. If one crashes or misbehaves it can&apos;t take the rest of the box down, and a plug-in that didn&apos;t ask for internet access is blocked from reaching it.</p>
        <div className="callout caution">
          <p><b>Only install plug-ins you trust.</b> Approving a permission limits what a plug-in may do; it doesn&apos;t guarantee it does only good things with that access.</p>
        </div>
      </section>

      <section>
        <h2>Write your own</h2>
        <p>A plug-in is a folder with a manifest and some JavaScript. It can add a channel, an on-screen overlay, settings, keyboard handling for its own channel, or a media source that supplies channel content from somewhere other than a local folder. The plug-in guide covers the API, and the repository has a starter plug-in to copy.</p>
        <p><span className="menu-path">Plug-in developer diagnostics</span> shows what each plug-in has registered, the permissions it has used and its recent logs, and can export a support bundle with credentials and personal paths removed.</p>
      </section>

      <section className="where">
        <h2>Where to find it</h2>
        <ul>
          <li><span className="menu-path">Setup › Plug-ins</span>.</li>
          <li>The <a href={repoFile('PLUGIN_DEVELOPMENT.md')}>plug-in developer guide</a> and the <a href={repoFile('plugin-dev-kit')}>starter kit</a>.</li>
        </ul>
      </section>
    </FeatureLayout>
  );
}
