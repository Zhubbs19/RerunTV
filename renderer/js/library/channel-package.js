// Portable single-channel packages. A package carries the channel plus only
// the flows/presets/pool entries it directly depends on; merge keeps the
// receiving box's unrelated settings intact and remaps collisions.
import { deepClone as clone } from '../core/util.js';

/**
 * Collects every tag that applies to a channel's files, including the channel's content tags.
 * @param {object} channel The channel config.
 * @returns {Set<string>} The tags.
 */
function fileTags(channel) {
  const tags = new Set();
  const collect = (files) => (files || []).forEach((file) => (file.tags || []).forEach((tag) => tags.add(tag)));
  collect(channel.files);
  (channel.blocks || []).forEach((block) => collect(block.files));
  // The channel's own contentTags (setup-panels.js's ADS tab — see
  // interstitials.js's effectiveContentTags) apply to every file on it for
  // matching purposes, so a flow/preset scoped only via one of those tags
  // still counts as depending on this channel for export purposes too.
  (channel.contentTags || []).forEach((tag) => tags.add(tag));
  return tags;
}

/**
 * Builds a portable package for one channel.
 * Includes only the flows, presets and ad-pool entries that name this channel, one of its
 * blocks, or a tag its files carry.
 * @param {object} config The box config.
 * @param {object} channel The channel config.
 * @returns {object} The package: `{ kind, version, channel, resources }`.
 */
export function buildChannelPackage(config, channel) {
  const blockIds = new Set((channel.blocks || []).map((block) => block.id));
  const tags = fileTags(channel);
  const interstitials = config.interstitials || {};
  const flows = (interstitials.flows || []).filter((flow) =>
    (flow.channels || []).includes(channel.number) ||
    ((flow.contentTags || []).length && flow.contentTags.some((tag) => tags.has(tag))));
  const presets = (interstitials.presets || []).filter((preset) =>
    (preset.channels || []).includes(channel.number) ||
    ((preset.contentTags || []).length && preset.contentTags.some((tag) => tags.has(tag))));
  const pool = (interstitials.pool || []).filter((entry) =>
    entry.channelAffinity === channel.number || blockIds.has(entry.blockAffinity));
  return {
    kind: 'reruntv-channel-package', version: 1,
    channel: clone(channel),
    resources: clone({ flows, presets, pool }),
  };
}

/**
 * Accepts a channel package, or a full config export holding exactly one channel.
 * @param {*} imported The parsed import file.
 * @returns {?object} A copy as a channel package, or `null` when it is neither.
 */
export function normalizeChannelPackage(imported) {
  if (imported && imported.kind === 'reruntv-channel-package' && imported.channel) return clone(imported);
  if (imported && Array.isArray(imported.channels) && imported.channels.length === 1) {
    return { kind: 'reruntv-channel-package', version: 1, channel: clone(imported.channels[0]), resources: { flows: [], presets: [], pool: [] } };
  }
  return null;
}

/**
 * Returns `preferred` if it is free, else a fresh id; either way marks it used.
 * @param {?string} preferred The id to keep if possible.
 * @param {Set<string>} used Ids already taken; the result is added.
 * @param {Function} makeId Makes a new candidate id.
 * @returns {string} The id.
 */
function uniqueId(preferred, used, makeId) {
  if (preferred && !used.has(preferred)) {
    used.add(preferred);
    return preferred;
  }
  let id;
  do { id = makeId(); } while (!id || used.has(id));
  used.add(id);
  return id;
}

/**
 * Merges a channel package into a config in place, remapping ids that collide.
 * @param {object} config The box config, mutated in place.
 * @param {object} pkg A channel package.
 * @param {object} opts Options.
 * @param {number} opts.targetNumber The channel number to import as.
 * @param {boolean} [opts.replace=false] Replace a channel already on that number.
 * @param {Function} opts.makeId Makes a new id for a block or resource that collides.
 * @returns {object} `{ channel, added, replaced, blockIdMap }`.
 * @throws {Error} When the number is taken and `replace` is false.
 */
export function mergeChannelPackage(config, pkg, { targetNumber, replace = false, makeId }) {
  const channel = clone(pkg.channel);
  const sourceNumber = channel.number;
  channel.number = targetNumber;
  const existingIndex = (config.channels || []).findIndex((entry) => entry.number === targetNumber);
  if (existingIndex >= 0 && !replace) throw new Error(`Channel ${targetNumber} already exists.`);

  const usedBlockIds = new Set();
  (config.channels || []).forEach((entry, index) => {
    if (index === existingIndex && replace) return;
    (entry.blocks || []).forEach((block) => usedBlockIds.add(block.id));
  });
  const blockIdMap = new Map();
  (channel.blocks || []).forEach((block) => {
    const oldId = block.id;
    block.id = uniqueId(oldId, usedBlockIds, makeId);
    blockIdMap.set(oldId, block.id);
  });

  if (existingIndex >= 0) config.channels.splice(existingIndex, 1, channel);
  else config.channels.push(channel);

  if (!config.interstitials) config.interstitials = {};
  const resources = pkg.resources || {};
  const added = { flows: 0, presets: 0, pool: 0 };
  ['flows', 'presets', 'pool'].forEach((kind) => {
    if (!Array.isArray(config.interstitials[kind])) config.interstitials[kind] = [];
    const used = new Set(config.interstitials[kind].map((entry) => entry.id));
    (resources[kind] || []).forEach((original) => {
      const entry = clone(original);
      entry.id = uniqueId(entry.id, used, makeId);
      if ((kind === 'flows' || kind === 'presets') && Array.isArray(entry.channels)) {
        entry.channels = entry.channels.map((number) => number === sourceNumber ? targetNumber : number);
      }
      if (kind === 'pool') {
        if (entry.channelAffinity === sourceNumber) entry.channelAffinity = targetNumber;
        if (blockIdMap.has(entry.blockAffinity)) entry.blockAffinity = blockIdMap.get(entry.blockAffinity);
      }
      config.interstitials[kind].push(entry);
      added[kind] += 1;
    });
  });
  return { channel, added, replaced: existingIndex >= 0, blockIdMap };
}
