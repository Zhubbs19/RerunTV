// The Time machine feature page (#/features/time-machine).
import { FEATURES, SHOTS, featureHref } from '../../site.js';
import { FeatureLayout, Shot } from '../../components/Layout.jsx';

const PAGE = FEATURES.find((page) => page.slug === 'time-machine');

/**
 * Renders the Time machine page.
 * @returns {JSX.Element} The page.
 */
export default function TimeMachinePage() {
  return (
    <FeatureLayout page={PAGE}>
      <section>
        <Shot src={SHOTS.timeMachine} alt="The time machine rewinding through a channel, with a strip of the programs it is passing below the picture" caption="Shuttling back through a channel's schedule." />
        <h2>Why it works</h2>
        <p>A RerunTV channel has no playback log to rewind. What airs at any moment is worked out from the channel and the time, so asking "what was on at 3 p.m. last Tuesday?" is the same question as "what's on now?" with a different clock. The time machine just moves the box's clock, and everything that follows it (the picture, the guide, the commercial breaks, reminders) moves with it.</p>
      </section>

      <section>
        <h2>Shuttle like a tape</h2>
        <p>Press <kbd>T</kbd>, then <kbd>←</kbd> or <kbd>→</kbd> to rewind or fast-forward. Tap the same direction again to step up through ×60, ×300, ×1800 and ×7200, in broadcast seconds per real second. The picture scrubs under head-switching noise like a VCR, and the readout names the program you'd land on.</p>
        <ul>
          <li><kbd>Enter</kbd> plays from that point.</li>
          <li><kbd>[</kbd> and <kbd>]</kbd> jump to the previous or next commercial break.</li>
          <li><kbd>\</kbd> jumps to the end of a break, a few seconds before the show comes back.</li>
          <li><kbd>L</kbd> returns to live.</li>
        </ul>
      </section>

      <section>
        <h2>Jump to a date</h2>
        <p>Press <kbd>D</kbd> for the calendar. The arrows move by day or week, <kbd>PgUp</kbd> and <kbd>PgDn</kbd> by month (with <kbd>Shift</kbd>, by year), <kbd>Home</kbd> goes to today, and <kbd>1</kbd>–<kbd>7</kbd> or <kbd>[</kbd> <kbd>]</kbd> set the time of day. Days with a date-range block on that channel, such as a December countdown or a holiday-weekend marathon, carry a dot, and the footer shows what would be airing at the moment you've picked.</p>
      </section>

      <section>
        <h2>Watch something from the beginning</h2>
        <p>The quickest way to see a particular show: open the <a href={featureHref('guide')}>guide</a>, select it and press <kbd>Enter</kbd>. The clock shifts so it starts from its first minute. With the time machine on, the guide also scrolls backward into the past.</p>
        <p>A channel's <span className="menu-path">Preview</span> in setup does the same thing without leaving the setup screen, with buttons to skip to the start of a show, the next break or an hour later, and its own calendar.</p>
      </section>

      <section>
        <h2>Set it up your way</h2>
        <p>The jumps and ranges are yours to change: which morning and weekend day the presets go to, how many days the date picker reaches, the week's first day, the scrubber's first step and span, the fastest shuttle speed and how far before the show the end-of-break jump lands.</p>
      </section>

      <section className="where">
        <h2>Where to find it</h2>
        <ul>
          <li>Switch it on under <span className="menu-path">Setup › Guide &amp; time machine › Time machine</span> first, then use <kbd>T</kbd>, <kbd>D</kbd> and <kbd>L</kbd>.</li>
          <li>It's also in the TV menu under <span className="menu-path">Time machine</span>, with <span className="menu-path">End of break</span>.</li>
        </ul>
      </section>
    </FeatureLayout>
  );
}
