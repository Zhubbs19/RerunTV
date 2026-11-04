// The Keyboard controls feature page (#/features/controls).
import { FEATURES, featureHref } from '../../site.js';
import { FeatureLayout } from '../../components/Layout.jsx';

const PAGE = FEATURES.find((page) => page.slug === 'controls');

// Keys while watching, by group: [group, [[keys, action], ...]]. Keys are written as
// space-separated names, "+" joins a chord.
const KEY_GROUPS = [
  ['Changing channel', [
    ['↑ ↓ PgUp PgDn', 'Change channel'],
    ['0–9', 'Type a channel number (tunes after about 1.4 seconds)'],
    ['.', 'Sub-channel separator while typing a number (7 . 1 tunes 7.1), when sub-channels are on'],
    ['Enter', 'Confirm a number, or show the channel banner'],
    ['Shift+↑ Shift+↓', 'Jump between favorite channels'],
    ['Backspace', 'Back to the last channel'],
    ['Shift+Backspace', 'Recent channels'],
    ['Ctrl+1–4', 'Save the channel to a quick-jump slot'],
    ['Alt+1–4', 'Recall a quick-jump slot'],
    ['N', 'SCAN: hold on each channel a few seconds; any key stops'],
  ]],
  ['Guide and information', [
    ['G', 'Open or close the full guide'],
    ['/', 'Filter channels (inside the guide)'],
    ['I', 'Program details for the current channel'],
    ['?', 'Open the TV menu'],
    ['H', 'Hide or show the hint bar'],
  ]],
  ['Time machine', [
    ['T', 'Time machine: shuttle like a tape with ← →'],
    ['D', 'Time-machine calendar: jump to any date and time'],
    ['L', 'Return to live'],
    ['J', 'Start the current show over'],
    ['[ ]', 'Previous or next commercial break (time machine only)'],
    ['X', 'Mark an air check to come back to'],
  ]],
  ['Picture and sound', [
    ['+ −', 'Volume up or down'],
    ['M', 'Mute or unmute'],
    ['Shift+M', 'Audio mode: stereo, mono or SAP'],
    ['C', 'CRT effects on or off'],
    ['V', 'Picture mode: standard, vivid or cinema'],
    ['A', 'Aspect: standard, stretch or fill'],
    ['K', 'Closed captions on or off'],
    ['F', 'Full screen'],
  ]],
  ['Breaks and overlays', [
    ['Q', 'Skip the commercial break that is playing'],
    ['B', 'A breaking-news bulletin on demand'],
    ['E', 'Test the emergency alert'],
    ['O', 'Logo and layout editor for the tuned channel'],
  ]],
  ['Power and setup', [
    ['P', 'Power off (any key wakes it)'],
    ['Z', 'Sleep timer: off, 30, 60, 90 or 120 minutes'],
    ['S', 'Go to setup'],
  ]],
];

/**
 * Draws a key combination as keycaps: "Shift+M" becomes Shift + M.
 * @param {Object} props
 * @param {string} props.keys Space-separated alternatives; "+" joins a chord.
 * @returns {JSX.Element} The keycaps.
 */
function Keys({ keys }) {
  const alternatives = keys === '+ −' ? ['+', '−'] : keys.split(' ');
  return alternatives.map((alt, i) => (
    <span key={alt + i}>
      {i > 0 ? ' ' : null}
      {(alt.length > 1 && alt.includes('+') ? alt.split('+') : [alt]).map((key, j) => (
        <span key={key + j}>{j > 0 ? ' + ' : null}<kbd>{key}</kbd></span>
      ))}
    </span>
  ));
}

/**
 * Renders the Keyboard controls page.
 * @returns {JSX.Element} The page.
 */
export default function ControlsPage() {
  return (
    <FeatureLayout page={PAGE}>
      <section>
        <p>These are the keys while watching. In <a href={featureHref('tv-mode')}>TV mode</a> the same actions sit on a remote&apos;s buttons, and the setup screen has keys of its own (see <a href={featureHref('setup')}>Setup</a>). The single-letter keys can be remapped under <span className="menu-path">Setup › System › Keys</span>.</p>
      </section>
      {KEY_GROUPS.map(([group, rows]) => (
        <section key={group}>
          <h2>{group}</h2>
          <div className="table-wrap">
            <table className="keys">
              <thead><tr><th scope="col">Key</th><th scope="col">Action</th></tr></thead>
              <tbody>
                {rows.map(([keys, action]) => (
                  <tr key={keys}><th scope="row"><Keys keys={keys} /></th><td>{action}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </FeatureLayout>
  );
}
