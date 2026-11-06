// The Setup, backups & updates feature page (#/features/setup).
import { FEATURES, SHOTS } from '../../site.js';
import { FeatureLayout, Shot } from '../../components/Layout.jsx';

const PAGE = FEATURES.find((page) => page.slug === 'setup');

/**
 * Renders the Setup, backups & updates page.
 * @returns {JSX.Element} The page.
 */
export default function SetupPage() {
  return (
    <FeatureLayout page={PAGE}>
      <section>
        <Shot src={SHOTS.setup} alt="The channel setup screen: a sidebar of sections, the channel list and the selected channel's settings" caption="Channel setup, with the channel list beside the selected channel's editor." />
        <h2>The setup screen</h2>
        <p>Press <kbd>S</kbd> any time to go to setup. Sections down the side cover Channels, Breaks, Library, Picture &amp; sound, On screen, Guide &amp; time machine, Household, System and Plug-ins, with a pinned status bar at the bottom and Help on the <kbd>?</kbd> button at the top. Every setting has one home, and a channel that sets its own value shows it on the matching page of that channel. Pick a channel from the list to open its editor, whose pages are Overview, Content, Schedule, Look, Breaks and Playback. <span className="menu-path">Start watching</span> goes back to the TV.</p>
        <p>Drag folders and files from your desktop straight onto it to add them.</p>
      </section>

      <section>
        <h2>Undo everything</h2>
        <p>Every change in setup is a named step you can undo with <kbd>Ctrl</kbd> + <kbd>Z</kbd> and redo with <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Z</kbd>, even a restored backup or a whole preset. A burst of typing or a slider drag counts as one step. Everyday watching, like changing channel or volume, isn&apos;t a setting and doesn&apos;t fill the history.</p>
      </section>

      <section>
        <h2>Search and the keyboard</h2>
        <ul>
          <li><kbd>Ctrl</kbd> + <kbd>K</kbd> searches everything on the screen: every setting by its place (a channel's own settings included), channels, upcoming programs and actions like adding a channel or exporting your settings.</li>
          <li>The arrow keys (or <kbd>J</kbd> and <kbd>K</kbd>) move between sections and rows, <kbd>Enter</kbd> opens a row, <kbd>Esc</kbd> goes back and <kbd>Ctrl</kbd> + <kbd>Enter</kbd> starts watching.</li>
          <li><kbd>G</kbd> and then a letter jumps to a section: <kbd>C</kbd> Channels, <kbd>P</kbd> Breaks, <kbd>L</kbd> Library, <kbd>S</kbd> Picture &amp; sound, <kbd>G</kbd> On screen, <kbd>T</kbd> Guide &amp; time machine, <kbd>H</kbd> Household, <kbd>Y</kbd> System, <kbd>U</kbd> Plug-ins, <kbd>?</kbd> Help.</li>
        </ul>
      </section>

      <section>
        <h2>Many channels at once</h2>
        <p><kbd>Ctrl</kbd>-click channels to pick several, <kbd>Shift</kbd>-click for a range or <kbd>Ctrl</kbd> + <kbd>A</kbd> for all, and the editor turns into bulk actions: favorite, delete, hide from tuning, or shift schedules by some hours, with a count of the programs that will move first.</p>
        <p><span className="menu-path">Preview</span> on any channel shows what it would play at any date and time without tuning to it. <span className="menu-path">Check channels</span> finds files that were moved or deleted outside the app, and <span className="menu-path">Fix playback</span> relinks or removes them.</p>
      </section>

      <section>
        <h2>Backups</h2>
        <p>Your settings are backed up on a rotating schedule, and <span className="menu-path">Snapshot now</span> takes one whenever you like.</p>
        <ul>
          <li><strong>Preview</strong> shows the differences in channels, titles, schedules and box settings before you restore.</li>
          <li><strong>Label and pin</strong> an important backup, such as "before reorganizing cartoons", so rotation never removes it.</li>
          <li><strong>Restore points</strong> are saved by themselves before big changes: importing a config, settings or a channel, applying a preset, or relinking a folder.</li>
        </ul>
      </section>

      <section>
        <h2>Channel packages</h2>
        <p><span className="menu-path">Export channel</span> makes a portable package of one channel and the programming it uses directly: its breaks, presets and pool entries. <span className="menu-path">Import channel</span> merges one into your box, renumbers anything that clashes, and can relink folders that live somewhere else on this computer, without touching unrelated settings.</p>
      </section>

      <section>
        <h2>Updates</h2>
        <p>RerunTV is in beta, and releases are numbered like 0.2.0-beta.7, where a higher beta number is always newer. Choose when updates happen:</p>
        <ul>
          <li>before the app opens, installing automatically;</li>
          <li>after it opens, installing when you quit;</li>
          <li>after it opens, asking when one is ready;</li>
          <li>only when you ask, or never.</li>
        </ul>
        <p>Your channels and settings live in a <code>userData</code> folder beside the app, and a backup is taken before an update installs, so an update keeps your lineup. The channel lineup is a plain <code>channels.json</code>; the media library, viewing history and saved lookups share one database file, <code>rerun.db</code>, which saves only what changed. <span className="menu-path">Help › What&apos;s new</span> lists what changed, and a card after an update points out the highlights.</p>
        <p>You can also choose how often RerunTV checks for updates.</p>
        <div className="callout">
          <p><b>Unsigned installers.</b> Beta installers aren&apos;t code-signed yet, so Windows warns the first time you run one. If you downloaded it from the project&apos;s own releases page, choose <span className="menu-path">More info</span> and then <span className="menu-path">Run anyway</span>.</p>
        </div>
      </section>

      <section className="where">
        <h2>Where to find it</h2>
        <ul>
          <li>Backups, updates and diagnostics: their pages under <span className="menu-path">Setup › System</span>.</li>
          <li>Export and import: a channel&apos;s menu in <span className="menu-path">Setup › Channels</span>.</li>
        </ul>
      </section>
    </FeatureLayout>
  );
}
