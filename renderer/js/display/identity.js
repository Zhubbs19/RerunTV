export function currentChannel(config, number) {
  return ((config && config.channels) || []).find((channel) => channel.number === number) || null;
}

export function channelIdentity(config, number) {
  const channel = currentChannel(config, number);
  return (channel && channel.broadcastIdentity) || null;
}

export function effectiveThemeId(config, number, boxOnly = false) {
  const identity = boxOnly ? null : channelIdentity(config, number);
  return (identity && identity.theme) || (config && config.theme) || 'digital-2000s';
}
