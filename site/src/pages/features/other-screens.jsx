// The Phones & other screens feature page (#/features/other-screens).
import { FEATURES, featureHref, repoFile } from '../../site.js';
import { FeatureLayout } from '../../components/Layout.jsx';

const PAGE = FEATURES.find((page) => page.slug === 'other-screens');

/**
 * Renders the Phones & other screens page.
 * @returns {JSX.Element} The page.
 */
export default function OtherScreensPage() {
  return (
    <FeatureLayout page={PAGE}>
      <section>
        <h2>A phone as the remote</h2>
        <p>Switch on LAN access in the Companion App plug-in and restart. Its pairing link opens a full remote in any browser on the same Wi-Fi, along with a mobile version of setup and file uploads. The short pairing code is exchanged for a private session before any controls or channel data are available.</p>
        <ul>
          <li>It only works on your home network, not over mobile data or from outside the house.</li>
          <li>If the page won't load, check the phone is on the same Wi-Fi as the box and not a guest network. That's the most common problem.</li>
          <li>A separate Android companion app adds quick-tap favorite channels you set up yourself, for one-handed use.</li>
        </ul>
        <div className="callout">
          <p><b>Some things stay on the box.</b> A paired remote can't change plug-in approvals or settings, network or update settings, the PIN lock, or the PC power options.</p>
        </div>
      </section>

      <section>
        <h2>Watch on other devices</h2>
        <p><span className="menu-path">Watch on other devices</span> is off by default. Switch it on, restart, and open its pairing link on a laptop, tablet or second TV. Each paired viewer is an independent copy of the lineup that can tune on its own without changing the main box, so the bedroom can watch channel 7 while the living room watches channel 3, and both are on the same point of the same schedule.</p>
        <p>Viewers receive schedule data and opaque media ids, never the paths of files on the host computer. When you change the lineup, paired screens hear about it and pick up the change straight away.</p>
      </section>

      <section>
        <h2>Run it as a server</h2>
        <p>Server mode runs RerunTV without the TV window and opens a small local control page with the pairing code, the viewer addresses, connection instructions and a Stop button. Headless mode is the same without opening that page. On Windows, <span className="menu-path">Start server when I sign in</span> starts server mode at sign-in; opening RerunTV from the Start menu while it's running switches cleanly to the full desktop window.</p>
      </section>

      <section>
        <h2>Cast to a TV</h2>
        <p>The Cast to TV plug-in sends whatever's airing to a cast-enabled TV or streaming device on your network, and keeps it in step with the live schedule.</p>
      </section>

      <section>
        <h2>Party guests</h2>
        <p>With the <a href={featureHref('channels')}>Party channel</a> on, the screen shows a QR code for a guest page. Guests need no account, only that link, and from it they can post a photo or short video to the screen, send a spoken announcement, play a sound effect, join a trivia round, enter a caption contest, vote for what plays next, check in on the guest wall and, if the jukebox is on, add or vote to skip a song. Nothing posted outlasts the session.</p>
      </section>

      <section>
        <h2>Who's connected</h2>
        <p><span className="menu-path">Connected devices</span> lists every remote, viewer and party guest active on your network right now. A device drops off about 30 seconds after it stops checking in.</p>
        <p>Pairing and sessions are explained in the project's <a href={repoFile('SECURITY.md')}>security notes</a>, including what to expect on a shared network: traffic on your LAN isn't encrypted.</p>
      </section>

      <section className="where">
        <h2>Where to find it</h2>
        <ul>
          <li>Viewer, server and connected devices: <span className="menu-path">Setup › System › Network &amp; devices</span>.</li>
          <li>Phone remote, casting and the party page: their plug-ins in <span className="menu-path">Setup › Plug-ins</span>.</li>
        </ul>
      </section>
    </FeatureLayout>
  );
}
