// The features index (#/features): every feature page as a row of a program guide.
import { FEATURES, featureHref } from '../site.js';
import { FeatureLayout } from '../components/Layout.jsx';

const INDEX_PAGE = {
  slug: '',
  ch: '01',
  title: 'Features',
  summary: 'Everything RerunTV can do, one page per feature. It all runs on your own computer, from your own media.',
};

/**
 * Renders the features index.
 * @returns {JSX.Element} The page.
 */
export default function FeaturesIndex() {
  return (
    <FeatureLayout page={INDEX_PAGE} eyebrow="Now listing" isIndex>
      <section>
        <div className="guide" role="list">
          <div className="guide-head" aria-hidden="true"><span>Channel</span><span>Program</span></div>
          {FEATURES.map((page) => (
            <div className="row" role="listitem" key={page.slug}>
              <div className="chan"><b>{page.ch}</b><a href={featureHref(page.slug)}>{page.title}</a></div>
              <p>{page.summary}</p>
            </div>
          ))}
        </div>
      </section>
    </FeatureLayout>
  );
}
