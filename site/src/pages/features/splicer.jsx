// The Video Splicer feature page (#/features/splicer).
import { FEATURES, featureHref, repoFile } from '../../site.js';
import { FeatureLayout } from '../../components/Layout.jsx';

const PAGE = FEATURES.find((page) => page.slug === 'splicer');

/**
 * Renders the Video Splicer page.
 * @returns {JSX.Element} The page.
 */
export default function SplicerPage() {
  return (
    <FeatureLayout page={PAGE}>
      <section>
        <h2>One long recording, many clips</h2>
        <p>Got an old tape or a rip with shows, commercials and bumpers all run together? The Splicer cuts it into separate clips and sorts them by length into episodes, commercials and bumpers. The recording itself is never changed.</p>
        <div className="callout">
          <p><b>Needs FFmpeg.</b> The Splicer uses FFmpeg, which you install yourself; the FFmpeg Transcode plug-in finds it on your PATH or at a location you set.</p>
        </div>
      </section>

      <section>
        <h2>How it works</h2>
        <ol className="steps">
          <li><strong>Find the cuts.</strong> Pick the recording. <span className="menu-path">Preview cuts</span> looks for black frames, silence, hard picture changes or a recurring logo card, and opens what it finds in the editor. <span className="menu-path">Review cuts</span> adds a before-and-after picture of every cut, and <span className="menu-path">Split</span> cuts straight away with no editing.</li>
          <li><strong>Edit.</strong> The cut editor has a player and a timeline. Add, nudge or drop cuts, merge clips, name and number episodes, and say where each one goes. It can also find commercials that aired twice so you keep only one. Then choose <span className="menu-path">Split these clips</span>.</li>
          <li><strong>Send them on.</strong> Clips start on the exact frame, without the dead air of the break, and go straight into RerunTV: episodes onto a channel, commercials and bumpers into the <a href={featureHref('breaks')}>ad pool</a>.</li>
        </ol>
        <p><span className="menu-path">Combine clips</span> does the opposite and joins clips into one file, re-encoding them first if their formats don't match.</p>
      </section>

      <section>
        <h2>Runs in the background</h2>
        <p>Splits wait in a queue and carry on while you do other things, with their progress shown as they go. The same tools also run from a terminal, for batch jobs.</p>
      </section>

      <section className="where">
        <h2>Where to find it</h2>
        <ul>
          <li><span className="menu-path">Setup › Library › Splicer</span>.</li>
          <li>Command-line use: <a href={repoFile('main/splicer/README.md')}>the Splicer's README</a>.</li>
        </ul>
      </section>
    </FeatureLayout>
  );
}
