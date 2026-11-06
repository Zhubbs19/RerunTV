// The Commercial breaks feature page (#/features/breaks).
import { FEATURES, featureHref } from '../../site.js';
import { FeatureLayout } from '../../components/Layout.jsx';

const PAGE = FEATURES.find((page) => page.slug === 'breaks');

/**
 * Renders the Commercial breaks page.
 * @returns {JSX.Element} The page.
 */
export default function BreaksPage() {
  return (
    <FeatureLayout page={PAGE}>
      <section>
        <h2>The bumper and ad pool</h2>
        <p>Everything that plays between shows lives in one shared pool: commercials, station IDs, "up next" bumpers and trivia cards. Add a whole folder at once, or add entries one at a time. A station ID can be text only, with no video file at all. Each entry is tagged with the channels or blocks it belongs to, so every break pulls from the right ones.</p>
        <p>RerunTV ships no commercials. You bring your own, the same way you bring your own shows.</p>
      </section>

      <section>
        <h2>When breaks happen</h2>
        <ul>
          <li><strong>A box-wide default</strong> sets how often breaks happen on any channel that doesn't set its own. Drag on the timeline or type exact break points.</li>
          <li><strong>Per channel</strong>, a channel can use its own bumper folder, its own interval, or break only before and after each show.</li>
          <li><strong>Per block</strong>, a stretch of the day can use different ads, or exist only to carve out an ad-free hour without changing what airs.</li>
          <li><strong>Presets</strong> save a break pattern and apply it to anything with a matching tag, so every show tagged "sitcom" breaks the same way.</li>
          <li><strong>The flow builder</strong> is a timeline for the rare channel that needs an exact order of segments, bumpers, ad pods and IDs, with its own simulator.</li>
        </ul>
        <p>A break that would land too close to a show's start or end, within a minute by default, moves to between programs. Ads can be kept from repeating too often, and a box-wide volume for commercials and bumpers sits beside the one for shows (see <a href={featureHref('sound')}>Sound</a>).</p>
      </section>

      <section>
        <h2>Shows pause for their breaks</h2>
        <p>A show stops where its break starts and picks up exactly there when the break ends, the way a broadcast really did. Rewind with the time machine, tune in mid-break or read the guide, and the show is always at the same point, because each program gets its full running time with its breaks inside it.</p>
        <ul>
          <li>Each break plays the same length every time it airs, with different ads of that length so it still varies. <strong>Ad variety</strong> can also allow slightly shorter ads (the rest of the slot stays black), or play the same ones every time.</li>
          <li>It's on by default. Turn it off box-wide, for one channel, or for one block.</li>
        </ul>
      </section>

      <section>
        <h2>Breaks at the fades</h2>
        <p>A break dropped at a fixed minute usually interrupts a scene. Switch on <span className="menu-path">Line up mid-show breaks with fades</span> and each break inside a show moves to the nearest fade to black, within three minutes by default, so it lands where the show was cut for commercials when it first aired. A break with no fade nearby stays where it was.</p>
        <p>Each file is read once to find its fades. <span className="menu-path">Find fades</span> does every show on channels that break inside shows; <span className="menu-path">Find act breaks</span> on a channel's titles page does just the files you pick. Expect about half a minute per episode and a few minutes per film. You can stop and carry on later.</p>
      </section>

      <section>
        <h2>Squeezed end credits</h2>
        <p><span className="menu-path">Speed up end credits</span> plays the credits fast beside a promo for what's on next, the way networks squeeze credits to the side, in a choice of four layouts. The same reading that finds fades also finds where a film's credits really start, so the squeeze begins there rather than at a fixed time before the end. The sped-up credits can be muted, kept as they are or turned down.</p>
      </section>

      <section>
        <h2>Fit programs to time slots</h2>
        <p>Real stations started programs on the hour and half hour. With <span className="menu-path">Fit programs to time slots</span> on, box-wide or per channel, every program ends on the next half hour or hour:</p>
        <ul>
          <li>A program that runs a little long is shortened first by speeding up its credits, then by playing it slightly fast, within limits you set, and it opens with a "formatted for television" card.</li>
          <li>A program that runs short gets breaks to fill the gap, from your ad pool or as placeholder slots.</li>
          <li>A 15-minute grid is there for channels of short programs.</li>
        </ul>
        <div className="callout">
          <p><b>Tip.</b> Keep the speed-up at 5% or below. Stations really did this, but above that voices start to sound rushed.</p>
        </div>
      </section>

      <section>
        <h2>Skip a break, or inspect one</h2>
        <p>Press <kbd>Q</kbd> (the blue button on a remote) to skip the break you're in. Like a DVR skipping ads, it moves you ahead to where the break ends and the show comes back. You choose whether <kbd>Q</kbd> works always, only in the time machine, or never. In the time machine, <kbd>\</kbd> jumps to a few seconds before a break ends, so you can check the cut back without sitting through the ads. In setup, <span className="menu-path">Air check</span> is a console that shows, for any channel and time, which source, block, show position and break policy the schedule resolves to and why, with the eligible pool entries and buttons to step to the previous or next boundary. <span className="menu-path">Force on TV</span> previews one entry without changing the real schedule.</p>
      </section>

      <section className="where">
        <h2>Where to find it</h2>
        <ul>
          <li>Cadence, pausing, ad variety, fades and presets: <span className="menu-path">Setup › Breaks › Cadence &amp; presets</span>.</li>
          <li>End credits, fitting to time slots, station breaks, flows and the pool: their own pages under <span className="menu-path">Setup › Breaks</span>.</li>
          <li>A channel's own breaks, ad interval, end credits and time-slot fitting: the channel's <span className="menu-path">Breaks</span> page.</li>
          <li>On a remote: <span className="menu-path">Setup › Breaks</span> in the TV menu.</li>
        </ul>
      </section>
    </FeatureLayout>
  );
}
