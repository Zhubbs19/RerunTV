// Virtual CH 0 (AUX/Video In) — real window/screen capture via Electron's
// desktopCapturer (plugins/video-in/main.js) + the legacy chromeMediaSource
// getUserMedia constraint, still supported and Electron's own documented
// pattern for this (the newer getDisplayMedia() path needs a main-process
// setDisplayMediaRequestHandler and is really aimed at letting a *remote*
// page request capture, not this app's own UI picking its own source).
// Migrated as-is from the old core aux-channel.js/virtual.js.
//
// Video-only: window-scoped loopback audio capture isn't reliably available
// across platforms (full-screen loopback is more consistent, a single
// window's own audio much less so) — capturing picture without sound is a
// defensible v1 scope, not an oversight.
let auxStream = null;
let currentContainer = null;
let currentCtx = null;

function stopCapture() {
  if (auxStream) {
    auxStream.getTracks().forEach((t) => { try { t.stop(); } catch (e) { /* already stopped */ } });
    auxStream = null;
  }
  if (currentCtx && currentCtx.player.srcObject) currentCtx.player.srcObject = null;
  if (currentContainer) currentContainer.querySelector('.video-in-channel').classList.remove('aux-capturing');
  closePicker();
}

async function startCapture(sourceId) {
  if (!currentContainer || !currentCtx) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        cursor: 'never',
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          cursor: 'never',
        },
      },
    });
    // Stop any prior capture only after the new one succeeds — an error
    // (source closed mid-pick, permission issue) shouldn't drop a capture
    // that was already working.
    stopCapture();
    auxStream = stream;
    currentCtx.player.removeAttribute('src');
    currentCtx.player.srcObject = stream;
    currentCtx.player.loop = false;
    await currentCtx.player.play().catch(() => {});
    currentContainer.querySelector('.video-in-channel').classList.add('aux-capturing');
    closePicker();
  } catch (e) {
    window.alertDialog(`Couldn't start capture: ${e.message}`, { variant: 'error' });
  }
}

async function openPicker() {
  if (!currentContainer) return;
  const container = currentContainer;
  const gridEl = container.querySelector('[data-el="picker-grid"]');
  gridEl.innerHTML = '<div class="aux-picker-empty">Loading sources…</div>';
  container.querySelector('[data-el="picker"]').classList.remove('hidden');
  let sources;
  try {
    sources = await window.api.listDesktopSources();
  } catch (e) {
    gridEl.innerHTML = '<div class="aux-picker-empty">Couldn\'t list capture sources.</div>';
    return;
  }
  if (currentContainer !== container) return; // tuned away while resolving
  gridEl.innerHTML = '';
  if (!sources.length) {
    gridEl.innerHTML = '<div class="aux-picker-empty">No capturable windows/screens found.</div>';
    return;
  }
  sources.forEach((src) => {
    const btn = document.createElement('button');
    btn.className = 'aux-picker-item';
    const img = document.createElement('img');
    img.src = src.thumbnailDataUrl;
    img.alt = src.name;
    const label = document.createElement('div');
    label.textContent = src.name;
    btn.appendChild(img);
    btn.appendChild(label);
    btn.addEventListener('click', () => startCapture(src.id));
    gridEl.appendChild(btn);
  });
}

function closePicker() {
  if (currentContainer) currentContainer.querySelector('[data-el="picker"]').classList.add('hidden');
}

window.RCBPlugins.registerChannelType('video-in', {
  number: 0,
  label: 'VIDEO IN',
  nowText: 'No Source Connected',
  badge: { bg: '#64748b', label: 'AUX' },
  render(container, ctx) {
    currentContainer = container;
    currentCtx = ctx;
    container.innerHTML = `
      <div class="video-in-channel">
        <div class="video-in-box">
          <div class="video-in-title">VIDEO IN</div>
          <div class="video-in-msg">NO VIDEO INPUT DETECTED</div>
          <div class="video-in-sub">CHECK VIDEO SOURCE CONNECTION</div>
          <button type="button" class="btn" data-el="select-source">SELECT SOURCE…</button>
        </div>
      </div>
      <div class="aux-picker hidden" data-el="picker">
        <div class="aux-picker-box">
          <div class="aux-picker-title">SELECT A WINDOW OR SCREEN</div>
          <div class="aux-picker-grid" data-el="picker-grid"></div>
          <button type="button" class="btn" data-el="picker-cancel">CANCEL</button>
        </div>
      </div>
    `;
    container.querySelector('[data-el="select-source"]').addEventListener('click', openPicker);
    container.querySelector('[data-el="picker-cancel"]').addEventListener('click', closePicker);
  },
  stop() {
    stopCapture();
    currentContainer = null;
    currentCtx = null;
  },
});
