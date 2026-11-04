// The Program details feature page (#/features/program-details).
import { FEATURES, featureHref } from '../../site.js';
import { FeatureLayout } from '../../components/Layout.jsx';

const PAGE = FEATURES.find((page) => page.slug === 'program-details');

/**
 * Renders the Program details page.
 * @returns {JSX.Element} The page.
 */
export default function ProgramDetailsPage() {
  return (
    <FeatureLayout page={PAGE}>
      <section>
        <h2>Better than file names</h2>
        <p>A guide full of file names is no fun. A channel's <span className="menu-path">Titles</span> page has several ways to fill in the real details: episode titles, descriptions, series names, ratings, posters and when an episode first aired. They only fill in what's empty, so nothing you typed yourself is overwritten.</p>
        <p>A match belongs to the file, not the channel, so every channel and block that plays the same file gets it too.</p>
      </section>

      <section>
        <h2>From the files you already have</h2>
        <p><span className="menu-path">Read NFO &amp; tags</span> reads what's already on your disk, with no internet needed:</p>
        <ul>
          <li>the <code>.nfo</code> files that media centers and library managers write next to your videos;</li>
          <li>the tags stored inside the video files themselves;</li>
          <li>a poster beside your media: a file's own <code>-poster</code> or <code>-thumb</code> image, or a <code>poster.jpg</code> or <code>folder.jpg</code> in its folder.</li>
        </ul>
        <p>To do every channel at once, or fill in new files as they arrive, use <span className="menu-path">Library › Sync › Details from your files</span>. When there's no poster at all, the details card uses a frame from the file itself.</p>
      </section>

      <section>
        <h2>Looked up online</h2>
        <h3>TheMovieDB</h3>
        <p>The TMDB Metadata plug-in looks titles up on TheMovieDB and needs a free API key. A file with a season and episode in its name, like <code>S02E01</code>, gets that episode's own title, description and air date; a feature-length file is matched to a film, and a year in the name picks the right version. It also brings the cast. <span className="menu-path">Match for selected</span> does many rows at once and looks each show up only once.</p>
        <h3>TVmaze</h3>
        <p>The TVmaze Episodes plug-in fills in episode titles, synopses and series names, and records when and on which network an episode first aired. It needs no account or key.</p>
        <div className="callout">
          <p><b>Your approval first.</b> Both lookup plug-ins reach the internet, so each asks for your permission before its first use. See <a href={featureHref('plugins')}>Plug-ins</a> for how permissions work.</p>
        </div>
      </section>

      <section>
        <h2>The details card</h2>
        <p>Press <kbd>I</kbd> while watching to see what was found: the series, the episode, the poster, the cast and when it first aired. It also says why the program is on, naming the block or lineup that picked it. Prefer it without the cast and air date? There's a switch for that.</p>
      </section>

      <section className="where">
        <h2>Where to find it</h2>
        <ul>
          <li>A channel's <span className="menu-path">Content › Titles</span> page: Read NFO &amp; tags, Match and TVmaze.</li>
          <li>Plug-in keys and settings: <span className="menu-path">Setup › Plug-ins</span>.</li>
          <li>Card options: <span className="menu-path">Setup › Guide &amp; Theme</span>.</li>
        </ul>
      </section>
    </FeatureLayout>
  );
}
