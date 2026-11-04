// The TV mode & remotes feature page (#/features/tv-mode).
import { FEATURES, featureHref } from '../../site.js';
import { FeatureLayout } from '../../components/Layout.jsx';

const PAGE = FEATURES.find((page) => page.slug === 'tv-mode');

/**
 * Renders the TV mode & remotes page.
 * @returns {JSX.Element} The page.
 */
export default function TvModePage() {
  return (
    <FeatureLayout page={PAGE}>
      <section>
        <h2>Desktop mode and TV mode</h2>
        <p>RerunTV has two ways of being used. <strong>Desktop mode</strong> is for a mouse and keyboard at a desk. <strong>TV mode</strong> is for a remote across the room: larger type, a focus you move with the arrow keys, and menus laid out for a D-pad. The mode belongs to each device, not to your channel setup, so a laptop can edit the lineup in desktop mode while the living-room box plays in TV mode.</p>
        <p>Each device picks its mode, strongest first, from:</p>
        <ul>
          <li>the choice you made on that device;</li>
          <li>the screen the window is on, if you've marked a screen as the TV (a PC driving a TV over HDMI as a second display);</li>
          <li>a launch option, <code>--mode=tv</code>;</li>
          <li>the device itself, such as the Android TV client or a smart TV's browser;</li>
          <li>otherwise, desktop.</li>
        </ul>
        <p>Nothing switches mode behind your back; at most, RerunTV suggests it.</p>
      </section>

      <section>
        <h2>A PC under the TV</h2>
        <p>The setup RerunTV is built around is a computer connected to a TV over HDMI, running the box full screen. Pick which screen it opens on and which speakers it plays through (the TV's, over HDMI), and it goes there every time.</p>
        <ul>
          <li><strong>Keep the display awake</strong> holds off the screen's sleep timer while the set is on. Video normally keeps a screen up, but a plug-in channel, a no-signal card or an open guide is a still picture as far as the computer is concerned. Powering the set off releases it.</li>
          <li><strong>Keep playback in sync</strong> checks every 20 seconds that the picture is where the schedule says it should be, and eases it back after the computer sleeps and wakes or a file stalls.</li>
          <li><strong>Shut down the PC from the box</strong> (off by default) adds <span className="menu-path">Shut down PC</span> to the TV menu and the phone remote, always with a 20-second countdown and Cancel. A second switch makes the box's own power-off shut the computer down too. Auto standby never does.</li>
        </ul>
      </section>

      <section>
        <h2>Remotes</h2>
        <p>In TV mode, remote buttons are routed by what's on screen: the arrows move focus in a dialog, change channel while watching and step a setting in the TV menu. Anything a keyboard key already does, the matching remote button does the same way.</p>
        <ul>
          <li><strong>The TV menu</strong> is a single column you can work through with arrows and OK, reaching the settings a remote needs. <kbd>◀</kbd> <kbd>▶</kbd> step a value.</li>
          <li><strong>Learn mode</strong> teaches the box what each button on your own remote means, per device.</li>
          <li><strong>HDMI-CEC</strong> (experimental, opt-in) lets the TV's own remote drive a PC through a CEC adapter.</li>
          <li>A keyboard-style remote or a USB IR receiver works as a keyboard, so every key on the <a href={featureHref('controls')}>controls</a> page can be remapped to suit it.</li>
        </ul>
      </section>

      <section>
        <h2>The Android TV client</h2>
        <p>The project includes a client for Android TV. It finds RerunTV on your network by itself, draws at a steady TV-sized resolution on 1080p and 4K panels, takes D-pad controls and serves a phone remote of its own. It sends the remote's raw button presses to RerunTV, which decides what each one means, so supporting a new remote doesn't need a new app.</p>
      </section>

      <section className="where">
        <h2>Where to find it</h2>
        <ul>
          <li>Usage mode and the TV screen: <span className="menu-path">Setup › Picture &amp; Sound</span>.</li>
          <li>Power, wake lock, sync and shutdown: <span className="menu-path">Setup › System › Power</span>.</li>
          <li>The TV menu: <kbd>?</kbd> on a keyboard, or the remote's menu button.</li>
        </ul>
      </section>
    </FeatureLayout>
  );
}
