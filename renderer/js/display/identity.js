// Per-channel broadcast identity lookups: which channel a number names, its own identity
// settings, and the theme pack in effect on it.

/**
 * Finds a channel by number.
 * @param {?object} config The app config.
 * @param {number} number The channel number.
 * @returns {?object} The channel, or null.
 */
export function currentChannel(config, number) {
  return ((config && config.channels) || []).find((channel) => channel.number === number) || null;
}

/**
 * A channel's own broadcast identity (`broadcastIdentity`), if it has one.
 * @param {?object} config The app config.
 * @param {number} number The channel number.
 * @returns {?object} The identity, or null.
 */
export function channelIdentity(config, number) {
  const channel = currentChannel(config, number);
  return (channel && channel.broadcastIdentity) || null;
}

/**
 * The theme pack in effect on a channel: its identity's theme, else the box theme, else the
 * default.
 * @param {?object} config The app config.
 * @param {number} number The channel number.
 * @param {boolean} [boxOnly=false] Ignore the channel's identity.
 * @returns {string} The theme id.
 */
export function effectiveThemeId(config, number, boxOnly = false) {
  const identity = boxOnly ? null : channelIdentity(config, number);
  return (identity && identity.theme) || (config && config.theme) || 'digital-2000s';
}
