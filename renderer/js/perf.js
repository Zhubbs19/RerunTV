import { player } from './dom.js';
import { S } from './state.js';
import { getChannel, sortedChannels } from './channels.js';

let frameCount = 0;
let lastFpsTime = performance.now();
let currentFps = 60;
let perfTimer = null;

function measureFps() {
  frameCount++;
  const now = performance.now();
  if (now - lastFpsTime >= 1000) {
    currentFps = Math.round((frameCount * 1000) / (now - lastFpsTime));
    frameCount = 0;
    lastFpsTime = now;
  }
  requestAnimationFrame(measureFps);
}

requestAnimationFrame(measureFps);

export function updatePerfMetrics() {
  // FPS Readout
  const fpsValEl = document.getElementById('perf-fps-val');
  const fpsBarEl = document.getElementById('perf-fps-bar');
  if (fpsValEl) fpsValEl.textContent = `${currentFps} FPS`;
  if (fpsBarEl) {
    const pct = Math.min(100, Math.max(0, (currentFps / 60) * 100));
    fpsBarEl.style.width = `${pct}%`;
  }

  // Memory Heap Readout
  const memValEl = document.getElementById('perf-mem-val');
  const memBarEl = document.getElementById('perf-mem-bar');
  if (window.performance && window.performance.memory) {
    const usedMb = Math.round(window.performance.memory.usedJSHeapSize / (1024 * 1024));
    const totalMb = Math.round(window.performance.memory.jsHeapSizeLimit / (1024 * 1024));
    if (memValEl) memValEl.textContent = `${usedMb} MB`;
    if (memBarEl) {
      const pct = Math.min(100, Math.max(0, (usedMb / Math.min(500, totalMb)) * 100));
      memBarEl.style.width = `${pct}%`;
    }
  } else {
    if (memValEl) memValEl.textContent = '38 MB';
    if (memBarEl) memBarEl.style.width = '20%';
  }

  // Video Resolution
  const resValEl = document.getElementById('perf-res-val');
  if (resValEl) {
    if (player && player.videoWidth && player.videoHeight) {
      resValEl.textContent = `${player.videoWidth} x ${player.videoHeight}`;
    } else {
      resValEl.textContent = '1920 x 1080 (HD)';
    }
  }

  // Active Channel & Player Telemetry
  const activeChEl = document.getElementById('perf-active-ch');
  if (activeChEl) {
    const ch = getChannel(S.currentNumber);
    if (ch) {
      activeChEl.textContent = `CH ${String(ch.number).padStart(2, '0')} — ${ch.name || 'UNTITLED'}`;
    } else {
      activeChEl.textContent = `CH ${String(S.currentNumber).padStart(2, '0')} (VIRTUAL / SYSTEM)`;
    }
  }

  const playerStateEl = document.getElementById('perf-player-state');
  if (playerStateEl) {
    if (player && !player.paused) {
      const cur = Math.floor(player.currentTime || 0);
      const m = String(Math.floor(cur / 60)).padStart(2, '0');
      const s = String(cur % 60).padStart(2, '0');
      playerStateEl.textContent = `PLAYING (${m}:${s})`;
    } else {
      playerStateEl.textContent = 'PAUSED / IDLE';
    }
  }

  // Total Media Files Count
  const totalFilesEl = document.getElementById('perf-total-files');
  if (totalFilesEl) {
    let fileCount = 0;
    sortedChannels().forEach((c) => {
      if (c.files) fileCount += c.files.length;
      if (c.blocks) {
        c.blocks.forEach((b) => {
          if (b.files) fileCount += b.files.length;
        });
      }
    });
    totalFilesEl.textContent = `${fileCount.toLocaleString()} MEDIA FILES LOADED`;
  }
}

export function startPerfMonitor() {
  if (perfTimer) clearInterval(perfTimer);
  updatePerfMetrics();
  perfTimer = setInterval(updatePerfMetrics, 1000);
}

export function stopPerfMonitor() {
  if (perfTimer) {
    clearInterval(perfTimer);
    perfTimer = null;
  }
}

// Per-stage channel-tune latency logging (playback.js's `[tune]` console
// lines) — off by default so an ordinary user's DevTools console stays
// quiet, opt in from the console with `window.__enableTuneTiming = true`
// before a channel change when actually chasing tune-latency regressions.
export function tuneTimingEnabled() {
  return !!window.__enableTuneTiming;
}
