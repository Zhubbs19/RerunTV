// The TV's picture is two <video> elements taking turns. One is on screen and called `player` by
// the rest of the app; the other (the standby) loads whatever comes next, already seeked, hidden.
// At a cut the standby takes over in an instant: no src change on the visible element, so no
// blank frame and no load wait. The outgoing element becomes the next standby.
//
// `player` is a Proxy that always forwards to whichever element is on screen, so the ~460
// places that read it keep working unchanged. The one thing that does not forward is element
// identity: compare with isPlayerElement(), never `el === player`.
//
// Permanent listeners (a plugin's `loadstart`) follow the swap. The per-segment ones
// (ended/error/loadedmetadata...) belong to a single load and stay with the element they were
// added to; their owners remove and re-add them around every segment anyway.
const PER_SEGMENT = new Set([
  'ended', 'error', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'seeked', 'seeking',
  'playing', 'waiting', 'stalled', 'timeupdate', 'durationchange', 'emptied', 'abort', 'pause', 'play',
]);
// A standby holding the show through a long break should not be dropped halfway through it.
const STANDBY_RELEASE_MS = 8 * 60 * 1000;

export function createPlayerPair(initial) {
  let current = initial;
  let standby = null;
  let standbyUrl = '';
  let releaseTimer = null;
  const permanent = []; // { type, fn, opts }

  const sameListener = (a, type, fn, opts) => a.type === type && a.fn === fn
    && !!(a.opts && (a.opts.capture || a.opts === true)) === !!(opts && (opts.capture || opts === true));

  function track(type, fn, opts) {
    if (!PER_SEGMENT.has(type) && !permanent.some((l) => sameListener(l, type, fn, opts))) permanent.push({ type, fn, opts });
  }

  function untrack(type, fn, opts) {
    const i = permanent.findIndex((l) => sameListener(l, type, fn, opts));
    if (i >= 0) permanent.splice(i, 1);
  }

  const player = new Proxy(initial, {
    get(_, prop) {
      if (prop === 'addEventListener') return (type, fn, opts) => { track(type, fn, opts); return current.addEventListener(type, fn, opts); };
      if (prop === 'removeEventListener') return (type, fn, opts) => { untrack(type, fn, opts); return current.removeEventListener(type, fn, opts); };
      const value = Reflect.get(current, prop, current);
      return typeof value === 'function' ? value.bind(current) : value;
    },
    set(_, prop, value) { return Reflect.set(current, prop, value, current); },
  });

  function makeStandby() {
    const el = document.createElement('video');
    el.id = 'player-standby';
    el.className = 'player-standby';
    el.muted = true;
    el.preload = 'auto';
    el.setAttribute('aria-hidden', 'true');
    current.insertAdjacentElement('afterend', el);
    return el;
  }

  function clearStandby() {
    clearTimeout(releaseTimer);
    releaseTimer = null;
    standbyUrl = '';
    if (!standby) return;
    try {
      standby.pause();
      standby.removeAttribute('src');
      standby.load();
    } catch (e) { /* only a hint */ }
  }

  // Start loading `url` into the standby, seeked to offsetS. Safe to call again for the same url.
  function prepareStandby(url, offsetS = 0) {
    try {
      if (!url) return;
      if (!standby) standby = makeStandby();
      standby.muted = true;
      if (standbyUrl !== url) {
        standbyUrl = url;
        standby.loop = false;
        standby.src = url;
        try {
          if (current.sinkId && typeof standby.setSinkId === 'function') standby.setSinkId(current.sinkId).catch(() => {});
        } catch (e) { /* only a hint */ }
      }
      const seek = () => {
        try { if (offsetS > 0 && offsetS < standby.duration) standby.currentTime = offsetS; } catch (e) { /* only a hint */ }
      };
      if (standby.readyState >= 1) seek();
      else standby.addEventListener('loadedmetadata', seek, { once: true });
      clearTimeout(releaseTimer);
      releaseTimer = setTimeout(clearStandby, STANDBY_RELEASE_MS);
    } catch (e) { /* only a hint */ }
  }

  function standbyReady(url) {
    return !!standby && standbyUrl === url && standby.readyState >= 2 && !standby.error && !standby.seeking;
  }

  // Put the standby on screen if it is holding `url` with a frame ready. Returns whether it did.
  function adoptStandby(url) {
    if (!standbyReady(url)) return false;
    const old = current;
    const next = standby;
    // Same look as the outgoing element, without animating into it.
    next.style.transition = 'none';
    next.className = old.className;
    next.style.cssText = old.style.cssText;
    next.style.transition = 'none';
    next.volume = old.volume;
    next.muted = old.muted;
    next.playbackRate = old.playbackRate;
    next.loop = old.loop;
    next.id = 'player';
    old.id = 'player-standby';
    permanent.forEach((l) => {
      old.removeEventListener(l.type, l.fn, l.opts);
      next.addEventListener(l.type, l.fn, l.opts);
    });
    current = next;
    void next.offsetWidth; // commit the copied look before transitions come back
    next.style.transition = '';
    old.pause();
    old.className = 'player-standby';
    old.style.cssText = '';
    standby = old;
    standbyUrl = '';
    clearStandby();
    return true;
  }

  return {
    player,
    prepareStandby,
    standbyReady,
    adoptStandby,
    releaseStandby: clearStandby,
    isPlayerElement: (el) => !!el && el === current,
  };
}
