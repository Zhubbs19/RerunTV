// Per-channel overlay panels: logo bug, end-credits speedup, dynamic overlays and
// ticker layout. Split out of panels.js; panels.js re-exports the builders.
import { foldLogoBugCorner } from '../core/channels.js';
import { applyLogoBugPlacement, updateLogoBug } from '../playback/broadcast-fx.js';
import { S, commitInPlace } from '../core/state.js';
import { basenameNoExt } from '../core/util.js';
import { commitOwnerFields, buildDynamicOverlaysEditor, buildIconOverridesEditor, buildLogoBugProfileEditor, openLiveLogoBugEditor, parsePositiveInt, safeApi } from './util.js';

// Per-channel override for the logo bug's placement profiles, layered over
// the box-wide DISPLAY-tab default the same way a block's ADS button
// overrides the channel default — null means "inherit."
export function buildLogoBugPanel(ch, panelEl) {
  function render() {
    panelEl.innerHTML = '';

    const inheritLabel = document.createElement('label');
    inheritLabel.className = 'shuffle-toggle';
    const inheritCheckbox = document.createElement('input');
    inheritCheckbox.type = 'checkbox';
    inheritCheckbox.checked = ch.logoBugProfiles != null;
    inheritCheckbox.addEventListener('change', () => {
      if (inheritCheckbox.checked) {
        // Seed the override starting from the box-wide default (a plain
        // copy, not a shared reference) rather than a fresh corner — the
        // channel's placement doesn't visibly change the instant OVERRIDE is
        // checked, only once actually dragged.
        const display = S.config.display || {};
        ch.logoBugProfiles = (display.logoBugProfiles || foldLogoBugCorner(null, null)).map((p) => ({ ...p }));
      } else {
        ch.logoBugProfiles = null;
      }
      applyLogoBugPlacement(ch);
      render();
      commitOwnerFields(ch, ['logoBugProfiles']);
    });
    inheritLabel.appendChild(inheritCheckbox);
    inheritLabel.appendChild(document.createTextNode('OVERRIDE LOGO BUG FOR THIS CHANNEL'));
    panelEl.appendChild(inheritLabel);

    // Some real networks drop their corner bug during commercial/bumper
    // breaks, some keep it up through them — independent of placement
    // override above, so it works whether or not this channel overrides the
    // box-wide profile. Default off (today's "always visible" behavior).
    const hideOnBreakRow = document.createElement('div');
    hideOnBreakRow.className = 'block-row';
    const hideOnBreakLabel = document.createElement('span');
    hideOnBreakLabel.className = 'block-count';
    hideOnBreakLabel.textContent = 'LOGO BUG DURING BREAKS';
    const hideOnBreakSelect = document.createElement('select');
    hideOnBreakSelect.className = 'block-hour-select';
    [['', 'BOX DEFAULT'], ['hide', 'HIDE IT'], ['show', 'KEEP IT UP']].forEach(([value, name]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = name;
      hideOnBreakSelect.appendChild(opt);
    });
    hideOnBreakSelect.value = ch.logoBugHidesOnBreak === true ? 'hide' : ch.logoBugHidesOnBreak === 'show' ? 'show' : '';
    hideOnBreakSelect.addEventListener('change', () => {
      if (hideOnBreakSelect.value === '') delete ch.logoBugHidesOnBreak;
      else ch.logoBugHidesOnBreak = hideOnBreakSelect.value === 'hide' ? true : 'show';
      commitOwnerFields(ch, ['logoBugHidesOnBreak']);
    });
    hideOnBreakRow.appendChild(hideOnBreakLabel);
    hideOnBreakRow.appendChild(hideOnBreakSelect);
    panelEl.appendChild(hideOnBreakRow);

    // The channel number chip under a logo: this channel can show it or hide
    // it whatever the box-wide setting says (DISPLAY › Logo bug), or inherit.
    const numberRow = document.createElement('div');
    numberRow.className = 'block-row';
    const numberLabel = document.createElement('span');
    numberLabel.className = 'block-count';
    numberLabel.textContent = 'CHANNEL NUMBER ON THE BUG';
    const numberSelect = document.createElement('select');
    numberSelect.className = 'block-hour-select';
    [['', 'BOX DEFAULT'], ['show', 'SHOW'], ['hide', 'HIDE']].forEach(([value, name]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = name;
      numberSelect.appendChild(opt);
    });
    numberSelect.value = ch.logoBugHideNumber === true ? 'hide' : ch.logoBugHideNumber === false ? 'show' : '';
    numberSelect.addEventListener('change', () => {
      if (numberSelect.value === '') delete ch.logoBugHideNumber;
      else ch.logoBugHideNumber = numberSelect.value === 'hide';
      commitOwnerFields(ch, ['logoBugHideNumber']);
      if (ch.number === S.currentNumber) updateLogoBug(ch);
    });
    numberRow.appendChild(numberLabel);
    numberRow.appendChild(numberSelect);
    panelEl.appendChild(numberRow);

    // Seasonal icon overrides (ch.iconOverrides, channels.js) — independent
    // of the placement-override checkbox above, since the icon is always
    // per-channel to begin with (no box-wide default icon to inherit from).
    const seasonalHeading = document.createElement('div');
    seasonalHeading.className = 'panel-toggle';
    seasonalHeading.textContent = 'SEASONAL ICON OVERRIDES';
    panelEl.appendChild(seasonalHeading);
    panelEl.appendChild(buildIconOverridesEditor(
      () => ch.iconOverrides,
      (overrides) => {
        ch.iconOverrides = overrides;
        commitInPlace({ type: 'channel.set', channel: ch.number, field: 'iconOverrides', value: overrides }, { coalesce: `ch:${ch.number}:iconOverrides` });
        applyLogoBugPlacement(ch);
      },
    ));

    if (ch.logoBugProfiles == null) {
      const hint = document.createElement('div');
      hint.className = 'titles-empty';
      hint.textContent = 'Uses the box-wide logo settings (Guide & theme)';
      panelEl.appendChild(hint);
      return;
    }

    panelEl.appendChild(buildLogoBugProfileEditor(
      () => ch.logoBugProfiles,
      (profiles) => {
        ch.logoBugProfiles = profiles;
        commitInPlace({ type: 'channel.set', channel: ch.number, field: 'logoBugProfiles', value: profiles }, { coalesce: `ch:${ch.number}:logoBugProfiles` });
      },
      () => applyLogoBugPlacement(ch),
      ch,
    ));
  }

  render();
}

// End-credits speedup — a real syndicated-TV trick: fast-forward (muted)
// through a movie's last stretch once its credits begin, squeezing the
// picture over to make room for an "UP NEXT" card, then resume normal speed
// for whatever airs next (playback.js's scheduleCreditsSpeedup/
// startCreditsSpeedup). Per-file overrides (creditsLeadS, 0 = never for
// that file) live in the TITLES tab's facets row instead, next to `rating` —
// this panel is only the channel-wide default.
export function buildCreditsSpeedupPanel(ch, panelEl) {
  function render() {
    panelEl.innerHTML = '';
    if (!ch.creditsSpeedup) ch.creditsSpeedup = { enabled: false, leadSeconds: 90, rate: 3, squeezeMode: 'text', squeezeBgImage: null };
    const cfg = ch.creditsSpeedup;

    const enabledLabel = document.createElement('label');
    enabledLabel.className = 'shuffle-toggle';
    const enabledCheckbox = document.createElement('input');
    enabledCheckbox.type = 'checkbox';
    enabledCheckbox.checked = !!cfg.enabled;
    enabledCheckbox.addEventListener('change', () => {
      cfg.enabled = enabledCheckbox.checked;
      render();
      commitOwnerFields(ch, ['creditsSpeedup']);
    });
    enabledLabel.appendChild(enabledCheckbox);
    enabledLabel.appendChild(document.createTextNode('SPEED UP END CREDITS'));
    panelEl.appendChild(enabledLabel);

    const hint = document.createElement('span');
    hint.className = 'panel-status';
    hint.textContent = 'Fast-forwards (muted) through the last stretch of a file once its credits begin, squeezing the picture aside for an UP NEXT card, then resumes normal speed for whatever airs next. A specific title can opt out (or set its own lead time) from the TITLES tab.';
    panelEl.appendChild(hint);

    if (!cfg.enabled) return;

    const grid = document.createElement('div');
    grid.className = 'field-grid';

    const leadInput = document.createElement('input');
    leadInput.type = 'number';
    leadInput.min = 1;
    leadInput.className = 'block-priority-input';
    leadInput.title = 'How many seconds before a file ends its credits are assumed to start, by default — a specific title can override this.';
    leadInput.value = cfg.leadSeconds || 90;
    leadInput.addEventListener('change', () => {
      cfg.leadSeconds = parsePositiveInt(leadInput.value, 90); leadInput.value = cfg.leadSeconds;
      commitOwnerFields(ch, ['creditsSpeedup']);
    });
    grid.appendChild(leadInput);
    const leadLabel = document.createElement('span');
    leadLabel.className = 'option-label';
    leadLabel.textContent = 'DEFAULT LEAD TIME (SEC BEFORE END)';
    grid.insertBefore(leadLabel, leadInput);

    const rateInput = document.createElement('input');
    rateInput.type = 'number';
    rateInput.min = 2;
    rateInput.max = 8;
    rateInput.className = 'block-priority-input';
    rateInput.title = 'Playback speed multiplier during the sped-up stretch.';
    rateInput.value = cfg.rate || 3;
    rateInput.addEventListener('change', () => {
      cfg.rate = Math.min(8, Math.max(2, parsePositiveInt(rateInput.value, 3)));
      rateInput.value = cfg.rate;
      commitOwnerFields(ch, ['creditsSpeedup']);
    });
    grid.appendChild(rateInput);
    const rateLabel = document.createElement('span');
    rateLabel.className = 'option-label';
    rateLabel.textContent = 'SPEED (×)';
    grid.insertBefore(rateLabel, rateInput);

    panelEl.appendChild(grid);

    // What fills the space #player's squeeze transform frees up. 'text' (the
    // original, still the default) is a static UP NEXT card; 'video' plays a
    // real, audible upNext-pool promo instead (startCreditsSpeedup falls
    // back to the text card if nothing eligible resolves in the pool for
    // this channel, so switching to VIDEO is never a silent no-op).
    const modeLabel = document.createElement('span');
    modeLabel.className = 'option-label';
    modeLabel.textContent = 'UP NEXT PANEL';
    panelEl.appendChild(modeLabel);
    const modeSelect = document.createElement('select');
    modeSelect.className = 'block-hour-select';
    [['text', 'TEXT CARD'], ['video', 'REAL PROMO VIDEO (FROM POOL)']].forEach(([value, label]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      modeSelect.appendChild(opt);
    });
    modeSelect.value = cfg.squeezeMode === 'video' ? 'video' : 'text';
    modeSelect.addEventListener('change', () => {
      cfg.squeezeMode = modeSelect.value;
      render();
      commitOwnerFields(ch, ['creditsSpeedup']);
    });
    panelEl.appendChild(modeSelect);

    // Channel-wide default backdrop for the squeeze panel — a specific
    // title can override this from the TITLES tab; blank at both levels
    // falls back to a plain card tinted with this channel's own accent
    // color (startCreditsSpeedup, playback.js). Only relevant in TEXT mode.
    if (cfg.squeezeMode !== 'video') {
      const bgBtn = document.createElement('button');
      bgBtn.type = 'button';
      bgBtn.className = 'btn';
      bgBtn.textContent = cfg.squeezeBgImage ? basenameNoExt(cfg.squeezeBgImage) : 'UP NEXT CARD BACKDROP…';
      bgBtn.addEventListener('click', async () => {
        const path = await safeApi('Opening the file picker', () => window.api.selectImage());
        if (!path) return;
        cfg.squeezeBgImage = path;
        render();
        commitOwnerFields(ch, ['creditsSpeedup']);
      });
      panelEl.appendChild(bgBtn);
      if (cfg.squeezeBgImage) {
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'btn remove-btn';
        clearBtn.textContent = 'CLEAR BACKDROP';
        clearBtn.addEventListener('click', () => {
          cfg.squeezeBgImage = null;
          render();
          commitOwnerFields(ch, ['creditsSpeedup']);
        });
        panelEl.appendChild(clearBtn);
      }
    }
  }

  render();
}

// Per-channel override for dynamic-overlay rules, same inherit/override
// convention as buildLogoBugPanel above — null means "use the box-wide
// DISPLAY-tab default list."
export function buildDynamicOverlaysPanel(ch, panelEl) {
  function render() {
    panelEl.innerHTML = '';

    const inheritLabel = document.createElement('label');
    inheritLabel.className = 'shuffle-toggle';
    const inheritCheckbox = document.createElement('input');
    inheritCheckbox.type = 'checkbox';
    inheritCheckbox.checked = ch.dynamicOverlays != null;
    inheritCheckbox.addEventListener('change', () => {
      if (inheritCheckbox.checked) {
        // Seed from the box-wide default (a plain copy) so the channel's
        // effective rules don't silently change the instant OVERRIDE is
        // checked — same reasoning as buildLogoBugPanel above.
        ch.dynamicOverlays = ((S.config.display && S.config.display.dynamicOverlays) || []).map((r) => ({ ...r }));
      } else {
        ch.dynamicOverlays = null;
      }
      render();
      commitOwnerFields(ch, ['dynamicOverlays']);
    });
    inheritLabel.appendChild(inheritCheckbox);
    inheritLabel.appendChild(document.createTextNode('Override dynamic overlays for this channel'));
    panelEl.appendChild(inheritLabel);

    if (ch.dynamicOverlays == null) {
      const hint = document.createElement('div');
      hint.className = 'titles-empty';
      hint.textContent = 'Uses the box-wide dynamic overlays (Guide & theme)';
      panelEl.appendChild(hint);
      return;
    }

    panelEl.appendChild(buildDynamicOverlaysEditor(
      () => ch.dynamicOverlays,
      (rules) => {
        ch.dynamicOverlays = rules;
        commitInPlace({ type: 'channel.set', channel: ch.number, field: 'dynamicOverlays', value: rules }, { coalesce: `ch:${ch.number}:dynamicOverlays` });
      },
      ch,
    ));
  }

  render();
}

// Per-channel override for the ticker plugin's on-screen placement AND its
// content (enabled/text/speed) — two independent inherit/override toggles,
// same convention as buildLogoBugPanel/buildDynamicOverlaysPanel above:
// null means "use the box-wide default." Placement
// (ch.tickerLayout, null = inherit S.config.display.overlayLayouts
// ['ticker-bar']) reuses the same live drag/resize editor every other HUD
// overlay is edited with — openLiveLogoBugEditor's perChannelOverlay option
// points its 'ticker-bar' target at ch.tickerLayout instead of the box-wide
// list while this editor session is open. Content
// (ch.tickerContent, null = inherit S.config.ticker) is edited inline here —
// same enabled/text/speed fields as plugins/ticker/settings.js's box-wide
// PLUGINS-tab panel, just scoped to this channel.
export function buildTickerLayoutPanel(ch, panelEl) {
  function render() {
    panelEl.innerHTML = '';

    // ---------- Placement ----------
    const placementInheritLabel = document.createElement('label');
    placementInheritLabel.className = 'shuffle-toggle';
    const placementInheritCheckbox = document.createElement('input');
    placementInheritCheckbox.type = 'checkbox';
    placementInheritCheckbox.checked = ch.tickerLayout != null;
    placementInheritCheckbox.addEventListener('change', () => {
      if (placementInheritCheckbox.checked) {
        // Seed from the box-wide default (a plain copy) so the channel's
        // effective placement doesn't silently change the instant OVERRIDE
        // is checked — same reasoning as buildLogoBugPanel above.
        const boxWide = (S.config.display && S.config.display.overlayLayouts && S.config.display.overlayLayouts['ticker-bar']) || [];
        ch.tickerLayout = boxWide.map((p) => ({ ...p }));
      } else {
        ch.tickerLayout = null;
      }
      render();
      commitOwnerFields(ch, ['tickerLayout']);
    });
    placementInheritLabel.appendChild(placementInheritCheckbox);
    placementInheritLabel.appendChild(document.createTextNode('Override ticker placement for this channel'));
    panelEl.appendChild(placementInheritLabel);

    if (ch.tickerLayout == null) {
      const hint = document.createElement('div');
      hint.className = 'titles-empty';
      hint.textContent = 'Uses the box-wide ticker placement (Guide & theme)';
      panelEl.appendChild(hint);
    } else {
      const explanation = document.createElement('p');
      explanation.className = 'panel-status logobug-live-description';
      explanation.textContent = `Edit the ticker bar on channel ${ch.number}. Each aspect and resolution combination keeps its own placement.`;
      const liveBtn = document.createElement('button');
      liveBtn.type = 'button';
      liveBtn.className = 'btn btn-primary logobug-live-open';
      liveBtn.textContent = `TUNE TO CHANNEL ${ch.number} & EDIT`;
      liveBtn.addEventListener('click', () => openLiveLogoBugEditor({
        getProfiles: () => ch.tickerLayout,
        setProfiles: (profiles) => {
          ch.tickerLayout = profiles;
          commitInPlace({ type: 'channel.set', channel: ch.number, field: 'tickerLayout', value: profiles }, { coalesce: `ch:${ch.number}:tickerLayout` });
        },
        perChannelOverlay: {
          targetId: 'ticker-bar',
          getProfiles: () => ch.tickerLayout,
          setProfiles: (profiles) => {
          ch.tickerLayout = profiles;
          commitInPlace({ type: 'channel.set', channel: ch.number, field: 'tickerLayout', value: profiles }, { coalesce: `ch:${ch.number}:tickerLayout` });
        },
        },
        channelNumber: ch.number,
      }));
      panelEl.append(explanation, liveBtn);
    }

    const divider = document.createElement('hr');
    divider.className = 'panel-divider';
    panelEl.appendChild(divider);

    // ---------- Content ----------
    const contentInheritLabel = document.createElement('label');
    contentInheritLabel.className = 'shuffle-toggle';
    const contentInheritCheckbox = document.createElement('input');
    contentInheritCheckbox.type = 'checkbox';
    contentInheritCheckbox.checked = ch.tickerContent != null;
    contentInheritCheckbox.addEventListener('change', () => {
      if (contentInheritCheckbox.checked) {
        const boxWide = S.config.ticker || { enabled: false, text: '', speed: 30 };
        ch.tickerContent = { ...boxWide };
      } else {
        ch.tickerContent = null;
      }
      window.applyTickerState?.();
      render();
      commitOwnerFields(ch, ['tickerContent']);
    });
    contentInheritLabel.appendChild(contentInheritCheckbox);
    contentInheritLabel.appendChild(document.createTextNode('Override ticker text/speed for this channel'));
    panelEl.appendChild(contentInheritLabel);

    if (ch.tickerContent == null) {
      const hint = document.createElement('div');
      hint.className = 'titles-empty';
      hint.textContent = 'Uses the box-wide ticker text/speed (Plug-ins tab)';
      panelEl.appendChild(hint);
      return;
    }

    const contentBody = document.createElement('div');
    contentBody.className = 'panel-body';
    const enabledLabel = document.createElement('label');
    enabledLabel.className = 'panel-toggle';
    const enabledEl = document.createElement('input');
    enabledEl.type = 'checkbox';
    enabledEl.checked = !!ch.tickerContent.enabled;
    enabledLabel.append(enabledEl, document.createTextNode('TEXT TICKER'));
    const textEl = document.createElement('textarea');
    textEl.className = 'pubaccess-slide-input';
    textEl.rows = 2;
    textEl.placeholder = 'Scrolling ticker text…';
    textEl.value = ch.tickerContent.text || '';
    const speedRow = document.createElement('div');
    speedRow.className = 'panel-interval';
    const speedEl = document.createElement('input');
    speedEl.type = 'number';
    speedEl.min = '5';
    speedEl.max = '120';
    speedEl.value = ch.tickerContent.speed || 30;
    speedRow.append('SPEED ', speedEl, ' SEC/LOOP (LOWER = FASTER)');
    contentBody.append(enabledLabel, textEl, speedRow);
    panelEl.appendChild(contentBody);

    enabledEl.addEventListener('change', () => {
      ch.tickerContent.enabled = enabledEl.checked;
      window.applyTickerState?.();
      commitOwnerFields(ch, ['tickerContent']);
    });
    textEl.addEventListener('input', () => {
      ch.tickerContent.text = textEl.value;
      window.applyTickerState?.();
      commitOwnerFields(ch, ['tickerContent'], { coalesce: `ch:${ch.number}:ticker-text` });
    });
    speedEl.addEventListener('change', () => {
      ch.tickerContent.speed = Math.min(120, Math.max(5, parseInt(speedEl.value, 10) || 30)); speedEl.value = ch.tickerContent.speed;
      window.applyTickerState?.();
      commitOwnerFields(ch, ['tickerContent']);
    });
  }

  render();
}
