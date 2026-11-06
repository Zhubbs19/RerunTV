// The The cable-box look feature page (#/features/look).
import { FEATURES, SHOTS, featureHref } from '../../site.js';
import { FeatureLayout, Shot } from '../../components/Layout.jsx';

const PAGE = FEATURES.find((page) => page.slug === 'look');

/**
 * Renders the The cable-box look page.
 * @returns {JSX.Element} The page.
 */
export default function LookPage() {
  return (
    <FeatureLayout page={PAGE}>
      <section>
        <Shot src={SHOTS.guideHd} alt="The program guide in the HD cable-box skin: black, square cells with a blue focus bar" caption="The HD skin, which new installs start on." />
        <h2>A cable-box layout in two skins</h2>
        <p>Two themes change more than colors: they switch the whole box to a layout modelled on a mid-2000s digital cable box. <strong>HD</strong> is black and square with a blue focus bar; <strong>Classic</strong> is royal blue and rounded with a pale-yellow one.</p>
        <ul>
          <li>The guide keeps live TV playing in its corner.</li>
          <li>A channel banner and mini guide sit over the picture.</li>
          <li><span className="menu-path">Menu</span> opens a quick menu, then the main menu.</li>
          <li><kbd>I</kbd> opens a full program page with its actions as icons.</li>
          <li>Pages of its own: search with an on-screen keyboard, listings by channel, and messages for reminders and downloaded updates.</li>
          <li>The setup screen changes to match, showing the setting you're on and what it does at the top.</li>
        </ul>
        <p>In a desktop window the layout uses smaller type, so the guide fits about twice as many channels. In <a href={featureHref('tv-mode')}>TV mode</a> it keeps type you can read from across the room.</p>
      </section>

      <section>
        <h2>13 themes, five decades</h2>
        <p>A theme changes the whole feel of the box at once: the channel-change animation, the idle screensaver, the sound effects, the guide and the picture's color. The packs run from a 1970s wood-console set through an '80s public-access look, a '94 scrolling guide, '90s network and early-2000s satellite menus and the two cable-box skins, to a 2016-style cloud guide. Where it suits the era, a theme can frame the picture in a bezel.</p>
        <p>A single channel can override the box theme, its tune sound, static style and accent colors through its <span className="menu-path">Identity</span> settings. Anything left on <span className="menu-path">Inherit</span> follows the box.</p>
      </section>

      <section>
        <h2>The CRT picture</h2>
        <p>Sliders for scanlines, vignette, grain, flicker, curvature and burn-in recreate an old tube, with a live preview as you drag. <kbd>C</kbd> switches the effect off and on.</p>
        <ul>
          <li><kbd>V</kbd> cycles picture-color presets: standard, vivid and cinema.</li>
          <li><kbd>A</kbd> cycles how the picture fits: <strong>standard</strong> letterboxing, <strong>stretch</strong> (deliberately distorted, like a widescreen picture squeezed onto an old set) and <strong>fill</strong>, which zooms to fill the screen.</li>
          <li><strong>Auto display mode</strong> imitates an era-appropriate resolution and shape per file or per theme.</li>
          <li>Power off and on with a CRT collapse and warm-up.</li>
        </ul>
      </section>

      <section>
        <h2>The logo bug</h2>
        <p>A channel can show its logo in a corner, like a network watermark. Leave it in one spot long enough and it develops a faint burn-in ghost, the way a real tube did. That's on purpose.</p>
        <p>Press <kbd>O</kbd> for the live layout editor: drag and anchor the logo and on-screen cards over the running channel, resize them with handles, and snap to a grid if you like.</p>
      </section>

      <section>
        <h2>Comfort and photosensitivity</h2>
        <div className="callout caution">
          <p><b>Some effects flicker or flash:</b> the flicker slider, the static burst when you change channel, the power animations, and the optional signal-glitch, breaking-news and emergency-alert overlays. Set flicker to 0, turn channel static off, press <kbd>C</kbd> to drop the CRT effect, and switch off the glitch and alert plug-ins if you're sensitive to flashing. First-run setup offers this as a choice between Full retro look, Gentle and Minimal. The pictures themselves come from your own media, which RerunTV can't change.</p>
        </div>
      </section>

      <section className="where">
        <h2>Where to find it</h2>
        <ul>
          <li>Themes: <span className="menu-path">Setup › On screen › Theme</span>.</li>
          <li>The logo bug and program cards: their pages under <span className="menu-path">Setup › On screen</span>.</li>
          <li>CRT sliders, picture and aspect: <span className="menu-path">Setup › Picture &amp; sound › Picture</span>.</li>
          <li>Logo and identity: a channel's <span className="menu-path">Look</span> page.</li>
        </ul>
      </section>
    </FeatureLayout>
  );
}
