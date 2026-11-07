// The guide's channel views: everything, just favorites, or "unseen lately"
// (channels not watched for UNSEEN_DAYS, from the viewing log). Pure, so it is
// tested; core/channels.js applies it inside filteredChannels().

export const GUIDE_VIEWS = ['all', 'favorites', 'unseen'];
export const UNSEEN_DAYS = 14;

export const GUIDE_VIEW_LABELS = {
  all: 'ALL CHANNELS',
  favorites: 'FAVORITES',
  unseen: `NOT WATCHED IN ${UNSEEN_DAYS} DAYS`,
};

/**
 * The guide view after `view` in `GUIDE_VIEWS`, wrapping around.
 * @param {string} view The current view id.
 * @returns {string} The next view id.
 */
export function nextGuideView(view) {
  const i = GUIDE_VIEWS.indexOf(view);
  return GUIDE_VIEWS[(i + 1) % GUIDE_VIEWS.length];
}

/**
 * Viewing-log rows ({ channelNumber, at }) -> Map(channelNumber -> latest `at`).
 * @param {Array<object>} entries Viewing-log rows.
 * @returns {Map<number, number>} Latest watch time per channel number.
 */
export function lastWatchedByChannel(entries) {
  const map = new Map();
  (entries || []).forEach((row) => {
    if (!row || !Number.isFinite(row.channelNumber) || !Number.isFinite(row.at)) return;
    if (!(map.get(row.channelNumber) >= row.at)) map.set(row.channelNumber, row.at);
  });
  return map;
}

/**
 * `now` is real time on purpose: the log's `at` is when something was really
 * watched, not a position in the simulated schedule.
 * Filters the guide's channels down to one view.
 * @param {Array<object>} channels The channel configs to filter.
 * @param {string} view The view id (`all`, `favorites`, `unseen`).
 * @param {object} opts What the views need.
 * @param {(number) => boolean} opts.isFavorite Whether a channel number is a favorite.
 * @param {Map<number, number>} opts.lastWatched Latest watch time per channel number.
 * @param {number} opts.now The real current time in ms.
 * @returns {Array<object>} The channels in the view.
 */
export function applyGuideView(channels, view, { isFavorite, lastWatched, now }) {
  if (view === 'favorites') return channels.filter((ch) => isFavorite(ch.number));
  if (view === 'unseen') {
    const cutoff = now - UNSEEN_DAYS * 86400000;
    return channels.filter((ch) => {
      const last = lastWatched && lastWatched.get(ch.number);
      return !(last >= cutoff);
    });
  }
  return channels;
}
