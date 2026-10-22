// One short line saying why this is on the air right now: which block,
// calendar day or default lineup picked the show, and which ad flow or cadence
// fills its breaks. Wording only; the facts come from explainLayers
// (core/schedule-query.js), which agrees with the real resolvers by construction.

function named(item, fallback) {
  const n = item && typeof item.name === 'string' ? item.name.trim() : '';
  return n || fallback;
}

export function describeWhyAiring(explained) {
  if (!explained || !Array.isArray(explained.layers)) return '';
  const parts = [];
  const wins = (group) => explained.layers.find((l) => l.group === group && l.role === 'wins');

  const content = wins('content');
  if (content) {
    if (content.kind === 'broadcastHours') parts.push('OUTSIDE BROADCAST HOURS');
    else if (content.kind === 'block') parts.push(`BLOCK: ${named(content.item, 'UNNAMED').toUpperCase()}`);
    else if (content.kind === 'dayOverride') parts.push(`CALENDAR DAY ${content.key}`);
    else parts.push('CHANNEL LINEUP');
  }

  const breaks = wins('breaks');
  if (breaks) {
    if (breaks.kind === 'adsSwitch') parts.push('ADS OFF');
    else if (breaks.kind === 'flow') parts.push(`ADS: FLOW ${named(breaks.item, 'UNNAMED').toUpperCase()}`);
    else if (breaks.kind === 'preset') parts.push(`ADS: PRESET ${named(breaks.item, 'UNNAMED').toUpperCase()}`);
    else if (breaks.kind === 'blockAds') parts.push('ADS: BLOCK SETTINGS');
    else if (breaks.kind === 'channelAds') parts.push('ADS: CHANNEL SETTINGS');
    else parts.push('ADS: BOX DEFAULT');
  }
  return parts.join('  ·  ');
}
