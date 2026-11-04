// The Sound feature page (#/features/sound).
import { FEATURES } from '../../site.js';
import { FeatureLayout } from '../../components/Layout.jsx';

const PAGE = FEATURES.find((page) => page.slug === 'sound');

/**
 * Renders the Sound page.
 * @returns {JSX.Element} The page.
 */
export default function SoundPage() {
  return (
    <FeatureLayout page={PAGE}>
      <section>
        <h2>Two volumes: shows and commercials</h2>
        <p>The box keeps separate levels for your shows and for commercials and bumpers, each a percentage you can adjust live with <kbd>+</kbd> and <kbd>−</kbd>. Turn the commercials up if your ads always sound quiet, or down if they blast. Any channel or block can set its own volume, which overrides both.</p>
        <p><kbd>M</kbd> mutes and unmutes.</p>
      </section>

      <section>
        <h2>The volume leveler</h2>
        <p>Files from different sources are rarely mastered to the same loudness. The leveler measures each file once in the background and evens them out:</p>
        <ul>
          <li><strong>On</strong> evens out loud and quiet files.</li>
          <li><strong>Consistent</strong> brings every show and commercial to one slightly lower common volume, so a loud ad no longer jumps out and a quiet file isn't stuck below the rest.</li>
        </ul>
      </section>

      <section>
        <h2>An old TV speaker</h2>
        <p>The vintage audio filter softens the sound a little and can add a faint hum and mechanical clicks. A separate plug-in adds ambient texture (tape hiss, static, carrier hum) that follows the active theme.</p>
        <p>The box's own sound effects, such as the channel click, volume tick and power thunk, are synthesized as they play. There are no audio files to replace.</p>
      </section>

      <section>
        <h2>Second audio program</h2>
        <p><kbd>Shift</kbd> + <kbd>M</kbd> cycles the audio mode through stereo, mono and SAP. With the SAP plug-in on, <kbd>U</kbd> switches between a file's own audio tracks, such as a dubbed language, when it has more than one.</p>
      </section>

      <section>
        <h2>Pick the speakers</h2>
        <p>On a PC with more than one audio output, RerunTV can send its sound to a particular device, such as the TV's speakers over HDMI, while the rest of the computer uses another. It can also open on a particular screen.</p>
      </section>

      <section className="where">
        <h2>Where to find it</h2>
        <ul>
          <li>Volumes, leveler, vintage filter and output device: <span className="menu-path">Setup › Picture &amp; Sound</span>.</li>
          <li>A channel's own volume: the channel's settings in <span className="menu-path">Setup › Channels</span>.</li>
        </ul>
      </section>
    </FeatureLayout>
  );
}
