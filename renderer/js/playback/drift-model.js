// Pure decision for the schedule-drift watchdog (playback/core.js checkScheduleDrift): given a
// snapshot of the player and where the schedule says it should be, what (if anything) should the
// watchdog do this tick. Kept DOM-free so the rules can be unit-tested.
//
//   'resume'  the player is paused (or its play() was rejected) while the schedule says content
//             should be airing: call play()
//   'nudge'   it claims to be playing but has had no data for a couple of ticks: re-seek it to
//             the schedule position to kick the pipeline
//   'seek'    it is playing fine but is more than the tolerance away from the schedule
//   'none'    leave it alone
export const DRIFT_TOLERANCE_S = 3;
export const DRIFT_TAIL_GUARD_S = 5;
// Consecutive ticks of "no data while supposedly playing" before a nudge.
export const STALL_TICKS_BEFORE_NUDGE = 2;

export function decideDriftAction({
  paused, seeking, ended, readyState, currentTime, duration, expected, stallTicks = 0,
}) {
  if (seeking || ended) return 'none';
  if (!Number.isFinite(duration) || duration <= 0) return 'none';
  if (!Number.isFinite(expected)) return 'none';
  if (paused) {
    // Needs at least its metadata, and not parked at the very end (the ended machinery owns that).
    if (readyState < 1) return 'none';
    if (expected >= duration - DRIFT_TAIL_GUARD_S) return 'none';
    return 'resume';
  }
  if (readyState < 3) {
    if (stallTicks + 1 >= STALL_TICKS_BEFORE_NUDGE && expected < duration - DRIFT_TAIL_GUARD_S) return 'nudge';
    return 'none';
  }
  if (expected >= duration - DRIFT_TAIL_GUARD_S) return 'none';
  if (Math.abs(expected - currentTime) < DRIFT_TOLERANCE_S) return 'none';
  return 'seek';
}
