// What the sign-on card says when the box starts: how long it has been away
// and which of the viewer's reminders are coming up. Pure; the card itself is
// playback/sign-on-card.js. All times are real clock (a reminder is a real
// appointment and "away" is real time), not viewNow().

export const AWAY_MIN_MS = 2 * 60 * 60 * 1000; // shorter absences aren't worth a card
export const DIGEST_WINDOW_MS = 12 * 60 * 60 * 1000;
export const DIGEST_MAX = 4;

export function formatAway(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} MIN`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} HR`;
  return `${Math.floor(hours / 24)} DAYS`;
}

// Returns { title, lines } or null when there is nothing worth saying.
export function buildSignOn({ now, lastSeenAt, reminders, formatTime }) {
  const lines = [];
  if (Number.isFinite(lastSeenAt) && lastSeenAt > 0 && now - lastSeenAt >= AWAY_MIN_MS) {
    lines.push(`AWAY FOR ${formatAway(now - lastSeenAt)}. THE SCHEDULE KEPT RUNNING.`);
  }
  const upcoming = (Array.isArray(reminders) ? reminders : [])
    .filter((r) => r && Number.isFinite(r.start) && r.end > now && r.start - now <= DIGEST_WINDOW_MS)
    .sort((a, b) => a.start - b.start);
  upcoming.slice(0, DIGEST_MAX).forEach((r) => {
    const where = `CH ${r.channelNumber}`;
    lines.push(`${r.start <= now ? 'NOW' : formatTime(r.start)}  ${String(r.title || '').toUpperCase()}  ${where}`);
  });
  if (upcoming.length > DIGEST_MAX) lines.push(`+ ${upcoming.length - DIGEST_MAX} MORE REMINDERS`);
  if (!lines.length) return null;
  return { title: upcoming.length ? 'WELCOME BACK · COMING UP' : 'WELCOME BACK', lines };
}
