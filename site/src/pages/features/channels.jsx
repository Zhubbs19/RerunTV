// The Built-in channels feature page (#/features/channels).
import { FEATURES, featureHref } from '../../site.js';
import { FeatureLayout } from '../../components/Layout.jsx';

const PAGE = FEATURES.find((page) => page.slug === 'channels');

// The built-in channels, in channel-number order.
const BUILT_IN = [
  ['0', 'Video In', 'A line input: shows a window or app running on the same computer, such as a karaoke app, as a channel.'],
  ['1', 'Preview Guide', 'A scrolling listings channel like an old cable preview guide, with a live clock, a rotating spotlight and now/next for every channel.'],
  ['2', 'Public Access', 'A community bulletin board that cycles through announcement slides you write.'],
  ['3', 'Local Weather', 'A weather barker channel with a generated forecast, or a real one from the US National Weather Service when you give it a location.'],
  ['51', 'Classified Intercept', 'A fictional radar-and-satellite log channel for late nights.'],
  ['94', 'Party', 'The interactive guest channel: photos, announcements, trivia, voting and a jukebox, driven from guests\' phones.'],
  ['96', 'Shopping Network', 'A parody home-shopping channel.'],
  ['98', 'Pay-Per-View', 'A parody scrambled channel: order a fake event, confirm the purchase, and the picture unscrambles for 30 seconds.'],
  ['99', 'Teletext Arcade', 'A parody teletext service with news, sports and weather pages, and a playable Snake game on page 999.'],
  ['100', 'Channel Mosaic', 'A grid of what\'s airing on every other channel right now, a screenful at a time.'],
  ['910', 'Digital Music Channel', 'Genre stations from your own music folders, styled like a digital-cable music service.'],
];

/**
 * Renders the Built-in channels page.
 * @returns {JSX.Element} The page.
 */
export default function ChannelsPage() {
  return (
    <FeatureLayout page={PAGE}>
      <section>
        <h2>Alongside your own channels</h2>
        <p>The box comes with a few special channels of its own. Each one is a plug-in, so you can switch any of them off on the <a href={featureHref('plugins')}>plug-ins</a> page, even the ones that start switched on. A built-in channel steps aside by itself if you already have a channel of your own on its number, and most can be renamed or moved to another number in the channel list.</p>
        <div className="table-wrap">
          <table className="keys">
            <thead><tr><th scope="col">Channel</th><th scope="col">What&apos;s on</th></tr></thead>
            <tbody>
              {BUILT_IN.map(([number, name, what]) => (
                <tr key={number}><th scope="row">CH {number} · {name}</th><td>{what}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>The channel mosaic</h2>
        <p>Channel 100 pages through your lineup a screenful at a time, showing what&apos;s airing on each channel right now. Each tile is a still frame taken from that channel&apos;s current position, not a live picture. That&apos;s deliberate: a wall of moving video would cost more than the rest of the box put together, and a real cable mosaic was a page of near-stills too.</p>
        <p>Tiles per page, how long a page stays up and how often frames refresh are all settings. If a big lineup makes the page stutter, lower the tile count first.</p>
      </section>

      <section>
        <h2>The digital music channel</h2>
        <p>Set up genre stations backed by your own music folders and flip between them like a digital-cable music service. Each track shows its artist, title and album art, read from the tags in your files. Pause and seek on demand, or search by song, artist, album or year. It asks for permission to read your music folders the first time.</p>
      </section>

      <section>
        <h2>The party channel</h2>
        <p>Switch it on and restart, and the idle party screen shows a QR code. Guests scan it with their phones, no account needed, to post photos and short videos, send spoken announcements, play sound effects, join trivia, enter a caption contest, vote for what plays next and add songs to the jukebox. Nothing posted outlasts the session. More on pairing guests is on the <a href={featureHref('other-screens')}>phones &amp; other screens</a> page.</p>
      </section>

      <section>
        <h2>The tape deck</h2>
        <p>The Tape Deck plug-in records what a channel actually broadcast, the shows plus the bumpers and commercials between them, into one file you can play back on its own channel, like taping a night of TV. It needs FFmpeg.</p>
      </section>

      <section className="where">
        <h2>Where to find it</h2>
        <ul>
          <li>Switch channels on or off, and set them up: <span className="menu-path">Setup › Plug-ins</span>.</li>
          <li>Rename or renumber them: the <span className="menu-path">Plug-in channels</span> part of the channel list.</li>
        </ul>
      </section>
    </FeatureLayout>
  );
}
