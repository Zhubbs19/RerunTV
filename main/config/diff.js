function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function channelMap(config) { return new Map(((config && config.channels) || []).map((channel) => [channel.number, channel])); }

function configSummary(config) {
  const channels = Array.isArray(config.channels) ? config.channels : [];
  return {
    channels: channels.length,
    files: channels.reduce((sum, channel) => sum + (channel.files || []).length, 0),
    blocks: channels.reduce((sum, channel) => sum + (channel.blocks || []).length, 0),
  };
}

function compareConfigs(current, snapshot) {
  const currentChannels = channelMap(current);
  const snapshotChannels = channelMap(snapshot);
  const addedChannels = [], removedChannels = [], renamedChannels = [], fileCountChanges = [], scheduleChanges = [];
  snapshotChannels.forEach((channel, number) => {
    const existing = currentChannels.get(number);
    if (!existing) { addedChannels.push({ number, name: channel.name || '' }); return; }
    if ((existing.name || '') !== (channel.name || '')) renamedChannels.push({ number, from: existing.name || '', to: channel.name || '' });
    const currentFiles = (existing.files || []).length;
    const snapshotFiles = (channel.files || []).length;
    if (currentFiles !== snapshotFiles) fileCountChanges.push({ number, current: currentFiles, snapshot: snapshotFiles });
    const currentSchedule = { blocks: existing.blocks || [], broadcastHours: existing.broadcastHours || null };
    const snapshotSchedule = { blocks: channel.blocks || [], broadcastHours: channel.broadcastHours || null };
    if (stable(currentSchedule) !== stable(snapshotSchedule)) scheduleChanges.push({ number, name: channel.name || existing.name || '' });
  });
  currentChannels.forEach((channel, number) => { if (!snapshotChannels.has(number)) removedChannels.push({ number, name: channel.name || '' }); });
  const ignored = new Set(['channels', '_isFirstRun']);
  const keys = new Set([...Object.keys(current || {}), ...Object.keys(snapshot || {})]);
  const settingsChanges = Array.from(keys).filter((key) => !ignored.has(key) && stable(current && current[key]) !== stable(snapshot && snapshot[key])).sort();
  return { addedChannels, removedChannels, renamedChannels, fileCountChanges, scheduleChanges, settingsChanges };
}

module.exports = { compareConfigs, configSummary };
