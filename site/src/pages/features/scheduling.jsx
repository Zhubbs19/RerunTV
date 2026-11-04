// The Scheduling feature page (#/features/scheduling).
import { FEATURES, featureHref } from '../../site.js';
import { FeatureLayout } from '../../components/Layout.jsx';

const PAGE = FEATURES.find((page) => page.slug === 'scheduling');

/**
 * Renders the Scheduling page.
 * @returns {JSX.Element} The page.
 */
export default function SchedulingPage() {
  return (
    <FeatureLayout page={PAGE}>
      <section>
        <h2>Loop, or keep a schedule</h2>
        <p>With nothing else set, a channel plays its whole library on a loop. That's often all you want. When you'd like an actual schedule, such as cartoons in the morning and movies at night, add programming blocks. They're entirely optional.</p>
      </section>

      <section>
        <h2>Programming blocks</h2>
        <p>A block is a time slot with its own lineup, for example "cartoons, weekdays, 4–6 p.m." It can be triggered two ways:</p>
        <ul>
          <li><strong>By day and time</strong>, repeating every week. This is dayparting: blocks swap a channel's folder by the hour, and the guide and playback both follow.</li>
          <li><strong>By date range</strong>, for a holiday, a countdown to Christmas or a weekend marathon. A date-range block takes over for those days and then hands the channel back.</li>
        </ul>
        <p>Turn on <span className="menu-path">Weekly rotation</span> and a block's lineup changes from week to week instead of repeating the same shows every time. Blocks can also carry their own commercial breaks, ads and volume.</p>
      </section>

      <section>
        <h2>ON AIR: the week as it will broadcast</h2>
        <p>The first view on a channel's <span className="menu-path">Schedule</span> page is ON AIR, a timeline of the week with every show, ad break and sign-off after blocks, calendar days, presets and flows have all been applied. Click a program to see which block or preset put it there, the breaks inside it, and a <span className="menu-path">Watch from here</span> button.</p>
        <p>ON AIR is editable. Drag and change things on the timeline, and before any edit is saved RerunTV previews which programs it would move. Every edit is one undo step.</p>
      </section>

      <section>
        <h2>The calendar</h2>
        <p>The calendar shows a whole month at once, colored by what's playing each day. It flags anything that conflicts, and you can override a single day without touching the regular schedule.</p>
      </section>

      <section>
        <h2>Playback order</h2>
        <p>A channel's titles can be sorted naturally, reversed, put back in folder order, given a repeatable shuffle, or dragged into the order you want. Changing the order gives the channel a new anchor time, so every automatic reorder shows you the effect and asks before it changes what's live.</p>
      </section>

      <section>
        <h2>Running behind, like a West Coast feed</h2>
        <p><span className="menu-path">Duplicate, running behind…</span> on a channel's menu makes a copy that runs a few hours behind the original, so the two are never on the same episode, like the East and West Coast feeds of a real network. Select several channels and the selection bar can shift their schedules by some hours too, telling you first how many programs will move.</p>
      </section>

      <section className="where">
        <h2>Where to find it</h2>
        <ul>
          <li>A channel's <span className="menu-path">Schedule</span> page: ON AIR, Blocks and Calendar.</li>
          <li>Playback order: the channel's <span className="menu-path">Content › Titles</span> page.</li>
          <li>To fill a schedule automatically from your library, see <a href={featureHref('library')}>smart channels and presets</a>.</li>
        </ul>
      </section>
    </FeatureLayout>
  );
}
