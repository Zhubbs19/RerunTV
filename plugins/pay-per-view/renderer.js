// Virtual CH 98 — a parody scrambled PPV channel. No config, no settings
// panel, no main-process backend — a rotating fake event card, an order
// flow (confirm modal -> 30s unscrambled window -> success modal), and the
// remote OK-button shortcut (onOk) to jump straight to the confirm modal.
// Migrated as-is from the old core ppv-hbo.js/virtual.js.
const PPV_PARODY_EVENTS = [
  { title: 'EVENT #401: WORLD CHAMPIONSHIP THUMB WRESTLING IX', price: '$49.95' },
  { title: 'EVENT #402: MONSTER TRUCK DESTRUCTION: GRAVE DIGGER VS DUMPSTER', price: '$29.95' },
  { title: 'EVENT #403: EXCLUSIVE LIVE SHOW: WATCHING PAINT DRY IN 4K', price: '$19.95' },
  { title: 'EVENT #404: 1995 PROFESSIONAL HIDE AND SEEK WORLD FINALS', price: '$39.95' },
  { title: 'EVENT #405: EXTREME MICROWAVE POPCORN CHAMPIONSHIP', price: '$14.95' },
];

// SETTINGS › Plug-ins › Pay-per-view can replace the parody lineup, change how
// often the featured event changes, and how long an order unscrambles for.
function ppvSettings() {
  return (window.RCBPlugins.ctx.getPluginSettings && window.RCBPlugins.ctx.getPluginSettings('pay-per-view')) || {};
}
function ppvEvents() {
  const custom = (ppvSettings().events || []).filter((e) => e && String(e.title || '').trim());
  return custom.length ? custom : PPV_PARODY_EVENTS;
}
function unscrambleSeconds() {
  const n = Number(ppvSettings().unscrambleSeconds);
  return Number.isFinite(n) ? Math.min(600, Math.max(5, n)) : 30;
}

let ppvEventIdx = 0;
let ppvUnscrambledUntil = 0;
let currentContainer = null;

function updateScrambleState() {
  if (!currentContainer) return;
  const overlay = currentContainer.querySelector('[data-el="scramble"]');
  if (overlay) overlay.classList.toggle('unscrambled', Date.now() < ppvUnscrambledUntil);
}

function openOrderModal() {
  if (!currentContainer) return;
  const event = ppvEvents()[ppvEventIdx] || ppvEvents()[0];
  currentContainer.querySelector('[data-el="modal-event"]').textContent = event.title;
  currentContainer.querySelector('[data-el="modal-price"]').textContent = event.price;
  currentContainer.querySelector('[data-el="modal"]').classList.remove('hidden');
}

function closeOrderModal() {
  if (!currentContainer) return;
  currentContainer.querySelector('[data-el="modal"]').classList.add('hidden');
}

function closeSuccessModal() {
  if (!currentContainer) return;
  currentContainer.querySelector('[data-el="success-modal"]').classList.add('hidden');
}

function confirmOrder() {
  closeOrderModal();
  window.playPurchaseConfirmSound();
  ppvUnscrambledUntil = Date.now() + unscrambleSeconds() * 1000;
  updateScrambleState();
  const event = ppvEvents()[ppvEventIdx] || ppvEvents()[0];
  if (!currentContainer) return;
  currentContainer.querySelector('[data-el="success-title"]').textContent = event.title;
  currentContainer.querySelector('[data-el="success-price"]').textContent = `${event.price} CHARGED TO CABLE BILL`;
  currentContainer.querySelector('[data-el="success-modal"]').classList.remove('hidden');
}

window.RCBPlugins.registerChannelType('pay-per-view', {
  number: 98,
  label: 'PAY-PER-VIEW',
  nowText: 'Restricted Scrambled Event',
  badge: { bg: '#ef4444', label: 'PPV' },
  onOk: openOrderModal,
  render(container, ctx) {
    currentContainer = container;
    const rotate = Number(ppvSettings().rotateMinutes);
    const slot = Math.floor(ctx.viewNow() / ((Number.isFinite(rotate) ? Math.min(240, Math.max(1, rotate)) : 15) * 60 * 1000));
    ppvEventIdx = slot % ppvEvents().length;
    const event = ppvEvents()[ppvEventIdx] || ppvEvents()[0];

    container.innerHTML = `
      <div class="ppv-channel">
        <div class="ppv-scramble-overlay" data-el="scramble"></div>
        <div class="ppv-box">
          <div class="ppv-header">
            <div class="ppv-badge">RESTRICTED ACCESS</div>
            <div class="ppv-title">RETRO PPV // CHANNEL 98 (SCRAMBLED)</div>
          </div>
          <div class="ppv-event-info">
            <div class="ppv-event-label">CURRENT PAY-PER-VIEW EVENT:</div>
            <div class="ppv-event-title">${event.title}</div>
            <div class="ppv-event-price">PRICE: ${event.price} / ONE-TIME PURCHASE</div>
          </div>
          <div class="ppv-actions">
            <button type="button" class="btn btn-primary ppv-order-btn" data-el="order-btn">💳 ORDER THIS EVENT NOW (${event.price})</button>
            <div class="ppv-hint">PRESS ENTER / OK OR CLICK ORDER TO PURCHASE</div>
          </div>
        </div>
      </div>

      <div class="preview-modal hidden" data-el="modal">
        <div class="preview-modal-box ppv-modal-box">
          <div class="ppv-badge" style="margin-bottom:12px;">💳 RESTRICTED PAY-PER-VIEW</div>
          <div class="preview-modal-title">CONFIRM PAY-PER-VIEW PURCHASE</div>
          <div class="ppv-modal-event" data-el="modal-event"></div>
          <div class="ppv-modal-price" data-el="modal-price"></div>
          <p class="ppv-modal-notice">⚠️ WARNING: This purchase will be added to your parents' monthly cable bill. Are you sure you want to order this event?</p>
          <div class="preview-modal-actions">
            <button data-el="modal-cancel" data-modal-dismiss class="btn">CANCEL</button>
            <button data-el="modal-confirm" data-modal-confirm class="btn btn-primary ppv-confirm-btn">💳 YES, CHARGE &amp; ORDER NOW</button>
          </div>
        </div>
      </div>

      <div class="preview-modal hidden" data-el="success-modal">
        <div class="preview-modal-box ppv-success-modal-box">
          <div class="ppv-success-badge">🎉 PURCHASE CONFIRMED</div>
          <div class="preview-modal-title">CABLE VISION PAY-PER-VIEW</div>
          <div class="ppv-modal-event" data-el="success-title"></div>
          <div class="ppv-modal-price" data-el="success-price"></div>
          <p class="ppv-modal-notice">Your ${unscrambleSeconds()}-second unscrambled viewing window has been activated. Enjoy the show!</p>
          <div class="preview-modal-actions">
            <button data-el="success-close" data-modal-dismiss class="btn btn-primary ppv-success-btn">📺 WATCH UNSCRAMBLED EVENT NOW</button>
          </div>
        </div>
      </div>
    `;

    updateScrambleState();
    container.querySelector('[data-el="order-btn"]').addEventListener('click', openOrderModal);
    container.querySelector('[data-el="modal-cancel"]').addEventListener('click', closeOrderModal);
    container.querySelector('[data-el="modal-confirm"]').addEventListener('click', confirmOrder);
    container.querySelector('[data-el="success-close"]').addEventListener('click', closeSuccessModal);
  },
  stop() {
    currentContainer = null;
  },
});
