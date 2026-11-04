// The Media library feature page (#/features/library).
import { FEATURES, featureHref } from '../../site.js';
import { FeatureLayout } from '../../components/Layout.jsx';

const PAGE = FEATURES.find((page) => page.slug === 'library');

/**
 * Renders the Media library page.
 * @returns {JSX.Element} The page.
 */
export default function LibraryPage() {
  return (
    <FeatureLayout page={PAGE}>
      <section>
        <h2>A catalogue of what you have</h2>
        <p>The library keeps a catalogue of every file in the folders your channels use, so you can tag and find things without digging through folders. <span className="menu-path">Scan</span> looks for new and changed files, and <span className="menu-path">Update location…</span> fixes the paths if you moved a whole folder yourself.</p>
        <div className="callout">
          <p><b>Read-only on your disk.</b> Nothing on your disk is ever moved, renamed or deleted from the library.</p>
        </div>
      </section>

      <section>
        <h2>Review: tags a show at a time</h2>
        <p>Review suggests tags such as era, genre, mood or rating, grouped by series or folder, so one decision covers a whole show. It can read your <a href={featureHref('program-details')}><code>.nfo</code> files and tags</a> first, so its suggestions use a show's real name. Accepting a suggestion changes only the catalogue; what airs doesn't change until you rebuild a smart channel.</p>
      </section>

      <section>
        <h2>Smart channels</h2>
        <p>A smart channel is built from a saved search over the catalogue, like "sitcoms from the 90s". Make one with <span className="menu-path">New saved query</span>, then <span className="menu-path">Build channel…</span>, and <span className="menu-path">Rebuild…</span> later to pick up new matches. You always see a preview of what will change on air first.</p>
        <p>With <span className="menu-path">Rebuild smart channels after a scan</span> on, a rebuild happens by itself only when what's on right now can stay on. Anything else waits for you.</p>
      </section>

      <section>
        <h2>Channel presets</h2>
        <p>A preset describes a whole channel by what it should be rather than by file paths: which kinds of programs, when they air, what plays in the breaks and what shows on screen. RerunTV fills it from your own library, and each preset shows how much of your library fits it.</p>
        <ul>
          <li>Building from a preset previews the result first, and the whole thing is a single undo step.</li>
          <li>Built-in presets include <strong>Music Videos</strong>, shuffled around the clock with the artist and song shown as each video starts, and <strong>Christmas TV</strong>.</li>
          <li>The preset creator makes your own: slots of programs by kind, genre, era, series or tag; weekly or date-range blocks or a 24/7 loop; ads that play only on that channel; shuffle; and the artist and song card. Start from scratch, from an existing channel, from a file or from a built-in preset.</li>
          <li><span className="menu-path">+ Add channel</span> offers the same presets, so a new channel can start from one.</li>
        </ul>
      </section>

      <section>
        <h2>Keeping up with new files</h2>
        <p>Library sync is off by default. Switch it on and it checks only the folders already linked to your channels, after startup or at an interval you choose, and adds new titles automatically.</p>
        <ul>
          <li>A likely rename keeps a title's details and tags, but only when the match is unambiguous.</li>
          <li>Missing titles are reported and kept by default. Removing them automatically is a separate option with its own warning.</li>
        </ul>
        <p>If you move or rename files outside the app, <span className="menu-path">Check channels</span> finds what's missing and <span className="menu-path">Fix playback</span> relinks or removes it.</p>
      </section>

      <section>
        <h2>Files that won't play</h2>
        <p>RerunTV plays <code>.mp4</code> (H.264) and <code>.webm</code> best, and scans <code>.mov</code> and <code>.m4v</code> too. With FFmpeg installed, a file the player can't decode is converted to H.264 once, and the original is moved to an <code>_originals_backup</code> folder beside it rather than deleted. <span className="menu-path">Fix playback</span> can convert a whole channel up front.</p>
      </section>

      <section className="where">
        <h2>Where to find it</h2>
        <ul>
          <li>Catalogue, Review, Smart channels, Presets and Sync: <span className="menu-path">Setup › Library</span>.</li>
          <li>Cutting a long recording into clips: the <a href={featureHref('splicer')}>Video Splicer</a>.</li>
        </ul>
      </section>
    </FeatureLayout>
  );
}
