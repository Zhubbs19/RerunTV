// The Households & DVR feature page (#/features/household).
import { FEATURES, featureHref } from '../../site.js';
import { FeatureLayout } from '../../components/Layout.jsx';

const PAGE = FEATURES.find((page) => page.slug === 'household');

/**
 * Renders the Households & DVR page.
 * @returns {JSX.Element} The page.
 */
export default function HouseholdPage() {
  return (
    <FeatureLayout page={PAGE}>
      <section>
        <h2>Who's watching</h2>
        <p>The household section is for sharing the box. Each person gets a profile, and their favorites, hidden channels, reminders, recordings, resume points and viewing history belong to it. The channels and the programming stay shared, so everyone sees the same lineup.</p>
      </section>

      <section>
        <h2>My shows and the DVR</h2>
        <p>Pick a program in the <a href={featureHref('guide')}>guide</a> and choose <span className="menu-path">Record once</span> or <span className="menu-path">Record series</span>. <span className="menu-path">My shows &amp; DVR</span> lists what the current profile has asked for.</p>
        <ul>
          <li><strong>Quota</strong> caps the space recordings use.</li>
          <li><strong>Keep</strong> holds only the newest few episodes of each series.</li>
          <li><strong>Simulated tuners</strong> limit how many recordings can happen at once, the way a real DVR could.</li>
        </ul>
        <p>Resume points pick a recording or program up where you left it.</p>
      </section>

      <section>
        <h2>Watch together</h2>
        <p><span className="menu-path">Watch together</span> starts a shared session that another screen on your network can join, so both stay on the same channel. See <a href={featureHref('other-screens')}>Phones &amp; other screens</a> for pairing a second screen.</p>
      </section>

      <section>
        <h2>Parental lock</h2>
        <p>The parental lock asks for a four-digit PIN before tuning to a channel or rating you restrict.</p>
        <div className="callout caution">
          <p><b>Change the PIN.</b> It starts as 1234, so change it before you rely on it. A paired phone can't change the lock; that stays on the box itself.</p>
        </div>
      </section>

      <section>
        <h2>Viewing history</h2>
        <p>The box keeps a log of each program that actually reached the screen, with an estimated watch time and your most-watched channel and program. It's stored apart from your channel setup and never included in a backup or export. You can clear it, or switch it off so nothing is logged at all.</p>
      </section>

      <section className="where">
        <h2>Where to find it</h2>
        <ul>
          <li>Profiles, DVR, watch together and parental lock: <span className="menu-path">Setup › Household</span>.</li>
          <li>Viewing history: <span className="menu-path">Setup › System › Diagnostics</span>.</li>
        </ul>
      </section>
    </FeatureLayout>
  );
}
