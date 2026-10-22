// The per-channel ADS toggle panel and the block-level commercials override
// panel. Split out of panels.js; panels.js re-exports both builders.
import { freshCommercialsConfig } from '../core/channels.js';
import { S } from '../core/state.js';
import { attachTagAutocomplete, buildBreakpointTrack, commitOwnerFields, parsePositiveInt } from './util.js';

// Per-channel ADS tab: a simple on/off toggle for ch.adsEnabled.
// All ad timing, flow, and scheduling lives in the Programming tab's
// SHOW & AD FLOWS / CADENCE & PRESETS panels — not per-channel.
export function buildChannelAdsPanel(ch, panelEl) {
  panelEl.innerHTML = '';

  const enabledLabel = document.createElement('label');
  enabledLabel.className = 'shuffle-toggle';
  const enabledCheckbox = document.createElement('input');
  enabledCheckbox.type = 'checkbox';
  enabledCheckbox.checked = ch.adsEnabled !== false;
  enabledCheckbox.addEventListener('change', () => {
    ch.adsEnabled = enabledCheckbox.checked;
    commitOwnerFields(ch, ['adsEnabled']);
  });
  enabledLabel.appendChild(enabledCheckbox);
  enabledLabel.appendChild(document.createTextNode('ADS ENABLED ON THIS CHANNEL'));
  panelEl.appendChild(enabledLabel);

  const hint = document.createElement('div');
  hint.className = 'titles-empty';
  hint.textContent = 'AD TIMING, BREAKS, POD SIZE, AND BUMPER POOL ARE CONFIGURED IN PROGRAMMING (CADENCE & PRESETS; ADVANCED FLOWS WHEN NEEDED). THIS TOGGLE IS A PER-CHANNEL MASTER SWITCH FOR ADS.';
  panelEl.appendChild(hint);

  // Channel-wide content tags — applied to EVERY file on this channel, on
  // top of that file's own tags, wherever an ad-pool entry/preset/flow
  // checks content tags (interstitials.js's effectiveContentTags). Exists
  // for a themed channel (a 24/7 holiday-movies channel, say) where tagging
  // every individual file the same way would be pure busywork when a preset
  // or pool entry just wants to target "this channel's content."
  const tagsLabel = document.createElement('div');
  tagsLabel.className = 'flow-label';
  tagsLabel.textContent = 'Channel content tags (apply to every file on this channel)';
  panelEl.appendChild(tagsLabel);

  const tagsInput = document.createElement('input');
  tagsInput.type = 'text';
  tagsInput.className = 'title-row-input';
  tagsInput.placeholder = 'e.g. christmas-ad, holiday';
  tagsInput.value = (ch.contentTags || []).join(', ');
  tagsInput.addEventListener('change', () => {
    ch.contentTags = tagsInput.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    commitOwnerFields(ch, ['contentTags']);
  });
  panelEl.appendChild(attachTagAutocomplete(tagsInput));

  const tagsHint = document.createElement('div');
  tagsHint.className = 'titles-empty';
  tagsHint.textContent = 'MATCHES AD-POOL ENTRIES, PRESETS, AND FLOWS THAT TARGET CONTENT TAGS — NO NEED TO TAG EVERY FILE INDIVIDUALLY.';
  panelEl.appendChild(tagsHint);
}

// Builds the ad-settings UI for a daypart block override (block.commercials).
// Only shown when a block opts out of inheriting the channel/flow default via
// the OVERRIDE ADS DURING THIS BLOCK checkbox (allowInherit: true).
// opts.onChange fires after every edit so the block row's summary can stay
// in sync without rebuilding the whole schedule panel.
export function buildCommercialsPanel(owner, panelEl, opts) {
  opts = opts || {};

  function render() {
    panelEl.innerHTML = '';

    if (opts.allowInherit) {
      const inheritLabel = document.createElement('label');
      inheritLabel.className = 'shuffle-toggle';
      const inheritCheckbox = document.createElement('input');
      inheritCheckbox.type = 'checkbox';
      inheritCheckbox.checked = !!owner.commercials;
      inheritCheckbox.addEventListener('change', () => {
        owner.commercials = inheritCheckbox.checked ? freshCommercialsConfig() : null;
        render();
        commitOwnerFields(owner, ['commercials']);
      });
      inheritLabel.appendChild(inheritCheckbox);
      inheritLabel.appendChild(document.createTextNode('OVERRIDE ADS DURING THIS BLOCK'));
      panelEl.appendChild(inheritLabel);

      if (!owner.commercials) {
        const hint = document.createElement('div');
        hint.className = 'titles-empty';
        hint.textContent = 'USES THE CHANNEL\'S AD SETTINGS';
        panelEl.appendChild(hint);
        if (opts.onChange) opts.onChange();
        return;
      }
    }

    const cc = owner.commercials;

    const enabledLabel = document.createElement('label');
    enabledLabel.className = 'shuffle-toggle';
    const enabledCheckbox = document.createElement('input');
    enabledCheckbox.type = 'checkbox';
    enabledCheckbox.checked = cc.enabled !== false;
    enabledCheckbox.addEventListener('change', () => {
      cc.enabled = enabledCheckbox.checked;
      render();
      commitOwnerFields(owner, ['commercials']);
    });
    enabledLabel.appendChild(enabledCheckbox);
    enabledLabel.appendChild(document.createTextNode('ADS ENABLED'));
    panelEl.appendChild(enabledLabel);

    if (cc.enabled === false) {
      if (opts.onChange) opts.onChange();
      return;
    }

    const poolHint = document.createElement('div');
    poolHint.className = 'titles-empty';
    poolHint.textContent = 'BUMPER CONTENT COMES FROM THE INTERSTITIALS POOL (PROGRAMMING TAB), TAGGED TO THIS CHANNEL OR "ANY" — THIS PANEL IS JUST WHEN/WHETHER BREAKS HAPPEN.';
    panelEl.appendChild(poolHint);

    const timingRow = document.createElement('div');
    timingRow.className = 'block-row';
    const timingLabel = document.createElement('span');
    timingLabel.className = 'block-count';
    timingLabel.textContent = 'BREAKS';
    const timingSelect = document.createElement('select');
    timingSelect.className = 'block-hour-select';
    [
      ['interval', 'ON A TIMER'],
      ['everyNMinutes', 'DURING EACH SHOW, EVERY N MIN'],
      ['breakpoints', 'DURING EACH SHOW, AT SET POINTS (%)'],
      ['pre', 'BEFORE EACH SHOW'],
      ['post', 'AFTER EACH SHOW'],
      ['both', 'BEFORE & AFTER EACH SHOW'],
    ].forEach(([value, label]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      timingSelect.appendChild(opt);
    });
    timingSelect.value = cc.timing || 'interval';
    timingSelect.addEventListener('change', () => {
      cc.timing = timingSelect.value;
      render();
      commitOwnerFields(owner, ['commercials']);
    });
    timingRow.appendChild(timingLabel);
    timingRow.appendChild(timingSelect);
    panelEl.appendChild(timingRow);

    if (!cc.timing || cc.timing === 'interval' || cc.timing === 'everyNMinutes') {
      const intervalRow = document.createElement('div');
      intervalRow.className = 'block-row';
      const intervalLabel = document.createElement('span');
      intervalLabel.className = 'block-count';
      intervalLabel.textContent = 'EVERY';
      const intervalInput = document.createElement('input');
      intervalInput.type = 'number';
      intervalInput.min = 1;
      intervalInput.className = 'block-hour-select';
      intervalInput.value = cc.intervalMinutes || '';
      intervalInput.placeholder = String((S.config.commercials && S.config.commercials.intervalMinutes) || 10);
      intervalInput.addEventListener('change', () => {
        cc.intervalMinutes = parsePositiveInt(intervalInput.value, null); intervalInput.value = cc.intervalMinutes != null ? cc.intervalMinutes : '';
        commitOwnerFields(owner, ['commercials']);
      });
      const intervalSuffix = document.createElement('span');
      intervalSuffix.className = 'block-count';
      intervalSuffix.textContent = 'MIN (BLANK = BOX DEFAULT)';
      intervalRow.appendChild(intervalLabel);
      intervalRow.appendChild(intervalInput);
      intervalRow.appendChild(intervalSuffix);
      panelEl.appendChild(intervalRow);
    }

    if (cc.timing === 'breakpoints') {
      const bpRow = document.createElement('div');
      bpRow.className = 'block-row';
      const bpLabel = document.createElement('span');
      bpLabel.className = 'block-count';
      bpLabel.textContent = 'AT';
      const bpInput = document.createElement('input');
      bpInput.type = 'text';
      bpInput.className = 'title-row-input';
      bpInput.placeholder = 'BREAK POINTS, % THROUGH SHOW (E.G. 25, 50, 75)';
      bpInput.value = (cc.breakpoints || []).join(', ');
      bpInput.addEventListener('change', () => {
        const pts = bpInput.value.split(',')
          .map((v) => parseFloat(v.trim()))
          .filter((v) => Number.isFinite(v) && v > 0 && v < 100);
        cc.breakpoints = pts.length ? pts : null;
        commitOwnerFields(owner, ['commercials']);
        render(); // re-syncs the drag track below to whatever was just typed
      });
      bpRow.appendChild(bpLabel);
      bpRow.appendChild(bpInput);
      panelEl.appendChild(bpRow);

      const track = buildBreakpointTrack(
        () => cc.breakpoints,
        (pts) => { cc.breakpoints = pts; commitOwnerFields(owner, ['commercials'], { coalesce: 'commercials:breakpoints' }); },
        bpInput,
      );
      panelEl.appendChild(track);
    }

    // Pod size: how many `commercial` entries play back-to-back per break.
    // 1/1 (the default) is exactly today's one-bumper-per-break behavior;
    // widening it plus adding adBreakIn/adBreakOut pool entries (PROGRAMMING
    // tab) gives a real ad "pod" — bump-in, 2-4 spots, bump-out.
    const podRow = document.createElement('div');
    podRow.className = 'block-row';
    const podLabel = document.createElement('span');
    podLabel.className = 'block-count';
    podLabel.textContent = 'POD SIZE';
    const podMinInput = document.createElement('input');
    podMinInput.type = 'number';
    podMinInput.min = 1;
    podMinInput.className = 'block-hour-select';
    podMinInput.value = cc.podMin || 1;
    podMinInput.addEventListener('change', () => {
      cc.podMin = parsePositiveInt(podMinInput.value, 1); podMinInput.value = cc.podMin;
      if ((cc.podMax || 1) < cc.podMin) {
        cc.podMax = cc.podMin;
        podMaxInput.value = cc.podMax;
      }
      podMaxInput.min = cc.podMin;
      if (opts.onChange) opts.onChange();
      commitOwnerFields(owner, ['commercials']);
    });
    const podSep = document.createElement('span');
    podSep.className = 'block-count';
    podSep.textContent = 'TO';
    const podMaxInput = document.createElement('input');
    podMaxInput.type = 'number';
    podMaxInput.min = cc.podMin || 1;
    podMaxInput.className = 'block-hour-select';
    podMaxInput.value = cc.podMax || 1;
    podMaxInput.addEventListener('change', () => {
      cc.podMax = Math.max(cc.podMin || 1, parsePositiveInt(podMaxInput.value, 1));
      podMaxInput.value = cc.podMax;
      if (opts.onChange) opts.onChange();
      commitOwnerFields(owner, ['commercials']);
    });
    const podSuffix = document.createElement('span');
    podSuffix.className = 'block-count';
    podSuffix.textContent = 'SPOTS PER BREAK';
    podRow.appendChild(podLabel);
    podRow.appendChild(podMinInput);
    podRow.appendChild(podSep);
    podRow.appendChild(podMaxInput);
    podRow.appendChild(podSuffix);
    panelEl.appendChild(podRow);

    // Per-channel/block "no repeats" overrides of the box-wide switches
    // (SETTINGS › Break cadence). Unset inherits.
    [
      ['noRepeatCommercials', 'NO REPEAT ADS'],
      ['noRepeatBumpers', 'NO REPEAT BUMPERS'],
      ['noRepeatInterstitials', 'NO REPEAT INTERSTITIALS'],
    ].forEach(([key, label]) => {
      const row = document.createElement('div');
      row.className = 'block-row';
      const text = document.createElement('span');
      text.className = 'block-count';
      text.textContent = label;
      const select = document.createElement('select');
      select.className = 'block-hour-select';
      [['', 'BOX DEFAULT'], ['on', 'ON'], ['off', 'OFF']].forEach(([value, name]) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = name;
        select.appendChild(opt);
      });
      select.value = cc[key] === true ? 'on' : cc[key] === false ? 'off' : '';
      select.addEventListener('change', () => {
        if (select.value === '') delete cc[key];
        else cc[key] = select.value === 'on';
        commitOwnerFields(owner, ['commercials']);
      });
      row.appendChild(text);
      row.appendChild(select);
      panelEl.appendChild(row);
    });

    if (opts.onChange) opts.onChange();
  }

  render();
}
