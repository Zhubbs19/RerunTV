// The Program guide feature page (#/features/guide).
import { FEATURES, SHOTS, featureHref } from '../../site.js';
import { FeatureLayout, Shot } from '../../components/Layout.jsx';

const PAGE = FEATURES.find((page) => page.slug === 'guide');

/**
 * Renders the Program guide page.
 * @returns {JSX.Element} The page.
 */
export default function GuidePage() {
  return (
    <FeatureLayout page={PAGE}>
      <section>
        <Shot src={SHOTS.guide} alt="The full program guide in the Classic cable-box skin: live TV in the corner, a grid of channels down the side and programs across half-hour columns" caption="The full guide in the Classic skin, with the tuned channel still playing in the corner." />
        <h2>A grid that's always right</h2>
        <p>Press <kbd>G</kbd> for the full guide: channels down the side, half-hour columns across the top and a live line marking the current minute. Because every channel's schedule is worked out from the clock, the guide isn't a cached listing that can drift from what's on. What it shows at 9:30 is what you'll see if you tune there at 9:30.</p>
        <ul>
          <li><strong>Channel icons.</strong> Give each channel an image, or keep the colored number badge it gets automatically.</li>
          <li><strong>Genre colors.</strong> An optional palette colors movies, news, sports, kids' programs and any genres of your own, using colors that suit the current theme.</li>
          <li><strong>Specials and short runs.</strong> Holiday blocks and marathons show up in the grid on the days they air, and a run of short clips is grouped rather than drawn as a hundred slivers.</li>
          <li><strong>Pick anything to watch it from the start.</strong> Select a program and press <kbd>Enter</kbd>: the <a href={featureHref('time-machine')}>time machine</a> moves the clock so it begins from its first minute.</li>
        </ul>
      </section>

      <section>
        <h2>Search the next seven days</h2>
        <p>Type two or more letters into the guide's search to find matching titles, descriptions and tags across the coming week. Choose a result and the guide jumps to it. On the cable-box layout, search has an on-screen keyboard for the remote and lists each show once with the number of times it airs; you can switch that grouping off to see every airing instead.</p>
        <p>The button beside search changes which channels the guide lists: all of them, your favorites, or the channels you haven't watched in the last two weeks.</p>
      </section>

      <section>
        <h2>Reminders</h2>
        <p>Pick a program and choose <span className="menu-path">Set reminder</span>. When it's about to start, a notice offers <span className="menu-path">Tune now</span> or <span className="menu-path">Dismiss</span>. Reminders run on the same clock as the schedule, so they work in the time machine too.</p>
        <ul>
          <li><strong>Tune automatically</strong> changes the channel the moment a reminder comes due.</li>
          <li><strong>Desktop notifications</strong> reach you while RerunTV plays in a window behind whatever you're working on. They only fire when the RerunTV window isn't the one in front.</li>
          <li>Every pending reminder is listed in one place, where you can remove one or clear them all. A reminder tidies itself away a few minutes after its program ends.</li>
        </ul>
        <p>On the cable-box layout, reminders also land in <span className="menu-path">Messages</span>, with an envelope in the corner of the screen counting them.</p>
      </section>

      <section>
        <h2>More ways to browse</h2>
        <ul className="facts">
          <li><b>Channel banner</b>Press <kbd>Enter</kbd> while watching for what's on now and next on the tuned channel.</li>
          <li><b>Mini guide</b>The cable-box layout's strip over the picture, for browsing other channels without leaving the show.</li>
          <li><b>Listings by channel</b>One channel's schedule as a list, hour after hour.</li>
          <li><b>Program page</b>Press <kbd>I</kbd> for the <a href={featureHref('program-details')}>details of a program</a>, with record and reminder actions.</li>
        </ul>
      </section>

      <section className="where">
        <h2>Where to find it</h2>
        <ul>
          <li><kbd>G</kbd> opens and closes the guide; <kbd>/</kbd> filters channels inside it.</li>
          <li>Guide options, genre colors and the reminder list: <span className="menu-path">Setup › Guide &amp; time machine › Guide</span>.</li>
        </ul>
      </section>
    </FeatureLayout>
  );
}
