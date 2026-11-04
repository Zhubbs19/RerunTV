// The Live channels feature page (#/features/live-tv).
import { FEATURES, SHOTS, featureHref } from '../../site.js';
import { FeatureLayout, Shot } from '../../components/Layout.jsx';

const PAGE = FEATURES.find((page) => page.slug === 'live-tv');

/**
 * Renders the Live channels page.
 * @returns {JSX.Element} The page.
 */
export default function LiveTvPage() {
  return (
    <FeatureLayout page={PAGE}>
      <section>
        <Shot src={SHOTS.live} alt="A channel playing, with the channel banner along the bottom showing the program, its time slot and what's on next" caption="Tuning in brings up the channel banner, like a real cable box." />
        <h2>A channel is a folder that never stops</h2>
        <p>Point a channel at one or more folders of video and RerunTV reads how long each file is. From then on, the channel behaves as if it had been looping through those files ever since you made it. Tune in at 8:17 and you join whatever reached minute 17 at 8:17, commercials included.</p>
        <p>Nothing plays in the background to make this work. Each channel has an anchor time, and the schedule is worked out from it whenever it's needed, so you can close the app for a week and every channel is still in the right place when you come back. The same arithmetic drives the <a href={featureHref('guide')}>guide</a>, the <a href={featureHref('time-machine')}>time machine</a> and the screens you <a href={featureHref('other-screens')}>pair on your network</a>, so they all agree.</p>
        <div className="callout">
          <p><b>Several folders, one loop.</b> Add cartoons and movies to the same channel, or keep them apart. Folders can be added and removed independently without rescanning the rest.</p>
        </div>
      </section>

      <section>
        <h2>Changing channel</h2>
        <ul>
          <li><kbd>↑</kbd> <kbd>↓</kbd> step through the lineup, or type a number and it tunes after a moment.</li>
          <li><kbd>Backspace</kbd> goes back to the last channel; <kbd>Shift</kbd> + <kbd>Backspace</kbd> shows a card of recent channels.</li>
          <li>Mark channels as favorites and jump between them with <kbd>Shift</kbd> + <kbd>↑</kbd> <kbd>↓</kbd>.</li>
          <li>Save up to four channels to quick-jump slots with <kbd>Ctrl</kbd> + <kbd>1</kbd>–<kbd>4</kbd> and recall them with <kbd>Alt</kbd> + the same number.</li>
          <li>A keyboard's next and previous track keys change channel too, and your system's now-playing overlay shows the channel and program.</li>
        </ul>
        <p>Each change plays a short burst of static and a channel-change sound to suit the theme, and the banner shows what's on now and what's next. About 45 seconds before a program ends, an up-next notice tells you what's coming.</p>
      </section>

      <section>
        <h2>SCAN</h2>
        <p>Press <kbd>N</kbd> and the box holds on each channel for about eight seconds, showing the banner as it goes, just like the SCAN button on an old cable box. Press any key to stop on whatever's on screen.</p>
      </section>

      <section>
        <h2>Sub-channels</h2>
        <p>Switch on <span className="menu-path">Allow sub-channels</span> and a channel can sit at 7.1 or 7.2 beside 7, the way a digital broadcast station carries extra channels. Type <kbd>7</kbd> <kbd>.</kbd> <kbd>1</kbd> to tune one. A sub-channel sorts straight after its main number and is an ordinary channel in every other way. The option is off by default so that number boxes keep stepping by whole numbers.</p>
      </section>

      <section>
        <h2>Air checks</h2>
        <p>Press <kbd>X</kbd> to mark the moment you're watching, then pick it from the TV menu later to jump straight back. Nothing is recorded: a channel plays the same thing at the same time however often you ask, so a mark is just a channel number and a point in time, a few dozen bytes.</p>
        <div className="callout caution">
          <p><b>Re-anchoring moves things.</b> Rescanning a channel's folder or changing its playback order gives it a new anchor time. A mark made before that lands on whatever airs at that moment afterwards.</p>
        </div>
      </section>

      <section>
        <h2>Sleep, power and start over</h2>
        <ul>
          <li><kbd>Z</kbd> cycles a sleep timer through 30, 60, 90 and 120 minutes.</li>
          <li><kbd>P</kbd> powers the set off with a CRT collapse; any key warms it back up. Auto standby can turn it off after a stretch with no input.</li>
          <li><kbd>J</kbd> starts the current show over from its beginning.</li>
        </ul>
      </section>

      <section className="where">
        <h2>Where to find it</h2>
        <ul>
          <li>Make channels in <span className="menu-path">Setup › Channels</span> with <span className="menu-path">+ Add channel</span> and <span className="menu-path">Add folder</span>.</li>
          <li>Sub-channels: the switch at the bottom of the channel list.</li>
          <li>The full key list is on the <a href={featureHref('controls')}>keyboard controls</a> page.</li>
        </ul>
      </section>
    </FeatureLayout>
  );
}
