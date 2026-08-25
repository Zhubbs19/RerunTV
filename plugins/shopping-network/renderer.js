// Virtual CH 96 — a parody home shopping channel. No config, no settings
// panel, no main-process backend — a rotating fake product card and an
// order confirmation modal, plus the remote OK-button shortcut (onOk) to
// jump straight to it. Migrated as-is from the old core
// ppv-hbo.js/virtual.js.
const HSN_PARODY_PRODUCTS = [
  { title: 'THE FLOWBEE VACUUM HAIRCUTTER', price: '$39.95', stock: 4, desc: 'Cuts your hair using high-suction vacuum power! Never visit a barber again.' },
  { title: '100-PACK PREMIUM BLANK VHS TAPES', price: '$19.99', stock: 12, desc: 'High grade T-120 cassette tapes. Perfect for recording Friday night sitcoms.' },
  { title: 'CHIA PET: THE MULLET EDITION', price: '$14.95', stock: 3, desc: 'Ch-ch-ch-chia! Grows lush green hair on business-in-front, party-in-back ceramic pets.' },
  { title: 'AS-SEEN-ON-TV POCKET FISHERMAN', price: '$24.95', stock: 8, desc: 'Folding fishing rod that fits right in your glove compartment.' },
  { title: 'GLOW-IN-THE-DARK ALIEN SKULL LAMP', price: '$29.95', stock: 6, desc: 'Authentic 90s bedroom illumination. Guaranteed 100% paranormal-free.' },
];

let hsnItemIdx = 0;
let currentContainer = null;

function orderItem() {
  if (!currentContainer) return;
  window.playPurchaseConfirmSound();
  const p = HSN_PARODY_PRODUCTS[hsnItemIdx];
  currentContainer.querySelector('[data-el="modal-item"]').textContent = p.title;
  currentContainer.querySelector('[data-el="modal-price"]').textContent = `ONLY ${p.price}`;
  currentContainer.querySelector('[data-el="modal"]').classList.remove('hidden');
}

function closeOrderModal() {
  if (!currentContainer) return;
  currentContainer.querySelector('[data-el="modal"]').classList.add('hidden');
}

window.RCBPlugins.registerChannelType('shopping-network', {
  number: 96,
  label: 'SHOPPING NETWORK',
  nowText: 'Live Product Showcase',
  badge: { bg: '#ec4899', label: 'HSN' },
  onOk: orderItem,
  render(container, ctx) {
    currentContainer = container;
    const slot = Math.floor(ctx.viewNow() / (10 * 60 * 1000));
    hsnItemIdx = slot % HSN_PARODY_PRODUCTS.length;
    const p = HSN_PARODY_PRODUCTS[hsnItemIdx];

    container.innerHTML = `
      <div class="hsn-channel">
        <div class="hsn-header">
          <div class="hsn-brand">RETRO SHOPPING NETWORK</div>
          <div class="hsn-live">● LIVE CALL-IN NOW</div>
        </div>
        <div class="hsn-card">
          <div class="hsn-title">${p.title}</div>
          <div class="hsn-price">ONLY ${p.price}</div>
          <div class="hsn-stock">⚠️ HURRY! ONLY ${p.stock} ITEMS REMAINING IN STOCK!</div>
          <div class="hsn-desc">${p.desc}</div>
          <button type="button" class="btn btn-primary hsn-order-btn" data-el="order-btn">📞 CALL &amp; BUY NOW (1-800-RETRO-SHOP)</button>
        </div>
        <div class="hsn-ticker">CALL 1-800-555-RETRO TO PLACE YOUR ORDER · SHIPS IN 3-5 BUSINESS DAYS VIA RETRO MAIL · NO CASH ON DELIVERY</div>
      </div>

      <div class="preview-modal hidden" data-el="modal">
        <div class="preview-modal-box hsn-modal-box">
          <div class="hsn-modal-badge">🛍️ ORDER CONFIRMED</div>
          <div class="preview-modal-title">RETRO SHOPPING NETWORK</div>
          <div class="hsn-modal-title" data-el="modal-item"></div>
          <div class="hsn-modal-price" data-el="modal-price"></div>
          <div class="hsn-modal-details">
            <span>📦 SHIPPING: 3-5 BUSINESS DAYS VIA RETRO MAIL</span><br>
            <span>💳 PAYMENT: CHARGED TO CABLE ACCOUNT</span><br>
            <span>📞 CALL CONFIRMATION: #800-RSN-904</span>
          </div>
          <div class="preview-modal-actions">
            <button data-el="modal-close" data-modal-dismiss class="btn btn-primary hsn-close-btn">🛍️ CONTINUE SHOPPING</button>
          </div>
        </div>
      </div>
    `;

    container.querySelector('[data-el="order-btn"]').addEventListener('click', orderItem);
    container.querySelector('[data-el="modal-close"]').addEventListener('click', closeOrderModal);
  },
  stop() {
    currentContainer = null;
  },
});
