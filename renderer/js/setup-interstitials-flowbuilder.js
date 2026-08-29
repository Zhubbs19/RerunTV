// PROGRAMMING tab: the Interactive Show & Ad Flow Builder — a self-contained
// subsystem (own timeline canvas renderer, own drag-reorder, own step-by-
// step simulator) split out of setup-interstitials.js, which still owns the
// interstitials pool/presets/standby panels. A "flow" is a named, reusable
// sequence of bumper/segment/ad-pod steps (e.g. "30-min cartoon block: intro
// bumper -> part 1 -> ad pod -> part 2 -> station ID") that content matching
// its contentTags/channels gets threaded through — this module is the setup-
// side editor for that; renderer/js/interstitials.js doesn't consume flows
// at all yet (see ensureFlowsConfig's two seeded defaults for the intended
// shape). labeledField is exported from setup-interstitials.js since both
// files build small "LABEL + control" form rows the same way.
import { getChannel, sortedChannels } from './channels.js';
import { flowCountBadgeEl } from './dom.js';
import { confirmDialog, alertDialog } from './setup-dialogs.js';
import { interstitialTypeDef, labeledField } from './setup-interstitials.js';
import { attachTagAutocomplete, buildBreakpointTrack, buildMediaThumbnail, parsePositiveInt } from './setup-util.js';
import { S, saveConfigDebounced } from './state.js';

export function ensureFlowsConfig() {
  if (!S.config.interstitials) S.config.interstitials = { pool: [], presets: [], flows: [] };
  if (!S.config.interstitials.flows || !S.config.interstitials.flows.length) {
    S.config.interstitials.flows = [
      {
        id: 'flow-cartoon-30m',
        name: '30-Min Dual-Episode Cartoon Flow',
        enabled: true,
        contentTags: ['cartoon', 'cartoon-30'],
        steps: [
          { id: 's1', type: 'upNext', name: 'Coming Up Next Bumper', tags: ['cartoon', 'network-intro'] },
          { id: 's2', type: 'contentSegment', name: 'Cartoon Episode Part 1 (~11 min)', tags: ['cartoon'] },
          { id: 's3', type: 'adPod', name: 'Mid-Roll Commercial Pod', podMin: 3, podMax: 4, bumpInTags: ['network'], commercialTags: ['90s-ads', 'toys'], bumpOutTags: ['cartoon'] },
          { id: 's4', type: 'contentSegment', name: 'Cartoon Episode Part 2 (~11 min)', tags: ['cartoon'] },
          { id: 's5', type: 'stationId', name: 'Network Station ID / Outro', tags: ['network', 'station-id'] }
        ]
      },
      {
        id: 'flow-prime-1h',
        name: '1-Hour Prime Time Show Flow',
        enabled: true,
        contentTags: ['prime-show', 'drama-1h'],
        steps: [
          { id: 'p1', type: 'upNext', name: 'Show Intro Bumper', tags: ['network-intro'] },
          { id: 'p2', type: 'contentSegment', name: 'Act 1 (~20 min)', tags: ['prime-show'] },
          { id: 'p3', type: 'adPod', name: 'Mid-Roll Pod A', podMin: 2, podMax: 3, bumpInTags: ['network'], commercialTags: ['retro-ads'], bumpOutTags: ['network'] },
          { id: 'p4', type: 'contentSegment', name: 'Act 2 (~20 min)', tags: ['prime-show'] },
          { id: 'p5', type: 'adPod', name: 'Mid-Roll Pod B', podMin: 3, podMax: 4, bumpInTags: ['network'], commercialTags: ['retro-ads'], bumpOutTags: ['network'] },
          { id: 'p6', type: 'contentSegment', name: 'Act 3 (~10 min)', tags: ['prime-show'] },
          { id: 'p7', type: 'stationId', name: 'Station ID & Credits', tags: ['station-id'] }
        ]
      }
    ];
  }
}

let activeFlowId = null;

export function renderFlowsList() {
  ensureFlowsConfig();
  const flows = S.config.interstitials.flows;
  if (!activeFlowId || !flows.some((f) => f.id === activeFlowId)) {
    activeFlowId = flows[0] ? flows[0].id : null;
  }

  const selectEl = document.getElementById('flow-template-select');
  if (!selectEl) return;

  if (flowCountBadgeEl) {
    flowCountBadgeEl.textContent = `${flows.length} FLOW${flows.length === 1 ? '' : 'S'}`;
  }

  selectEl.innerHTML = '';
  flows.forEach((f) => {
    const opt = document.createElement('option');
    opt.value = f.id;
    const stepCount = (f.steps || []).length;
    opt.textContent = `${f.name || '(untitled flow)'} (${stepCount} step${stepCount === 1 ? '' : 's'})`;
    selectEl.appendChild(opt);
  });
  selectEl.value = activeFlowId || '';

  const activeFlow = flows.find((f) => f.id === activeFlowId);
  if (!activeFlow) return;

  const nameInput = document.getElementById('flow-name-input');
  if (nameInput) {
    nameInput.value = activeFlow.name || '';
  }

  const enabledCheckbox = document.getElementById('flow-enabled-checkbox');
  if (enabledCheckbox) {
    enabledCheckbox.checked = activeFlow.enabled !== false;
  }

  const channelsContainer = document.getElementById('flow-target-channels-container');
  if (channelsContainer) {
    channelsContainer.innerHTML = '';
    const chSelect = document.createElement('select');
    chSelect.className = 'block-hour-select flow-select';
    chSelect.setAttribute('aria-label', 'Target channels');
    
    const optAll = document.createElement('option');
    optAll.value = 'all';
    optAll.textContent = 'ALL CHANNELS';
    chSelect.appendChild(optAll);

    sortedChannels().forEach((c) => {
      const opt = document.createElement('option');
      opt.value = String(c.number);
      opt.textContent = `CH ${String(c.number).padStart(2, '0')} ${c.name || 'UNTITLED'}`;
      chSelect.appendChild(opt);
    });

    const pillsWrap = document.createElement('div');
    pillsWrap.className = 'flow-channel-pills-wrap';

    const renderChannelPills = () => {
      pillsWrap.innerHTML = '';
      const selected = activeFlow.channels || [];
      if (!selected.length) {
        const badge = document.createElement('span');
        badge.className = 'flow-channel-pill all-chs';
        badge.textContent = '🌐 ALL CHANNELS';
        pillsWrap.appendChild(badge);
      } else {
        selected.forEach((num) => {
          const chObj = getChannel(num);
          const pill = document.createElement('span');
          pill.className = 'flow-channel-pill';
          pill.textContent = `CH ${String(num).padStart(2, '0')}${chObj && chObj.name ? ' (' + chObj.name + ')' : ''} `;
          const removeBtn = document.createElement('span');
          removeBtn.className = 'pill-remove';
          removeBtn.textContent = '✕';
          removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            activeFlow.channels = activeFlow.channels.filter((n) => n !== num);
            renderChannelPills();
            updateFlowStatusBanner(activeFlow);
            saveConfigDebounced();
          });
          pill.appendChild(removeBtn);
          pillsWrap.appendChild(pill);
        });
      }
    };

    chSelect.addEventListener('change', () => {
      const val = chSelect.value;
      if (val === 'all') {
        activeFlow.channels = [];
      } else {
        const num = parseInt(val, 10);
        if (!activeFlow.channels) activeFlow.channels = [];
        if (!activeFlow.channels.includes(num)) {
          activeFlow.channels.push(num);
        }
      }
      chSelect.value = 'all';
      renderChannelPills();
      updateFlowStatusBanner(activeFlow);
      saveConfigDebounced();
    });

    renderChannelPills();
    channelsContainer.appendChild(chSelect);
    channelsContainer.appendChild(pillsWrap);
  }

  const tagsContainer = document.getElementById('flow-target-tags-container');
  if (tagsContainer) {
    tagsContainer.innerHTML = '';
    const tagsInput = document.createElement('input');
    tagsInput.type = 'text';
    tagsInput.className = 'title-row-input';
    tagsInput.placeholder = 'e.g. cartoon, cartoon-30';
    tagsInput.value = (activeFlow.contentTags || []).join(', ');
    tagsInput.addEventListener('change', () => {
      activeFlow.contentTags = tagsInput.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
      updateFlowStatusBanner(activeFlow);
      saveConfigDebounced();
    });
    tagsContainer.appendChild(attachTagAutocomplete(tagsInput));
  }

  updateFlowStatusBanner(activeFlow);
  renderFlowCadencePanel(activeFlow);
  renderFlowTimelineCanvas(activeFlow);
}

// MID-SHOW AD CADENCE — the cadence-preset functionality (a fixed "every N
// minutes" timer, or breaks "at set % points" through whatever's airing)
// folded directly into the flow itself (flow.cadence), rather than living
// only in the separate CADENCE & PRESETS tab where a matching flow would
// always win and the preset would silently never fire (computeActiveCommercials,
// schedule.js, checks flows before presets). This panel's breaks fire
// *within* the currently-airing content segment/file, layered underneath the
// flow's own bumper/pod step sequence (which still governs episode/file
// boundaries via the timeline canvas above) — so a flow can now do both: an
// authored intro/outro/mid-roll-pod structure AND a plain wall-clock or
// percentage-based ad cadence, instead of having to pick one.
function ensureFlowCadence(flow) {
  if (!flow.cadence) {
    flow.cadence = {
      enabled: false, timing: 'everyNMinutes', intervalMinutes: 10, breakpoints: [],
      podMin: 1, podMax: 1, bumpInTags: [], commercialTags: [], bumpOutTags: [], contentTags: [],
    };
  }
  // A cadence object saved before contentTags existed lacks the field
  // entirely (undefined, not []) — normalize so every read site can treat
  // "no scoping" uniformly rather than checking for both.
  if (!Array.isArray(flow.cadence.contentTags)) flow.cadence.contentTags = [];
  return flow.cadence;
}

function renderFlowCadencePanel(flow) {
  const container = document.getElementById('flow-cadence-container');
  if (!container) return;
  container.innerHTML = '';
  const cadence = ensureFlowCadence(flow);

  const headerRow = document.createElement('div');
  headerRow.className = 'flow-cadence-header-row';

  const enabledLabel = document.createElement('label');
  enabledLabel.className = 'shuffle-toggle';
  const enabledCheckbox = document.createElement('input');
  enabledCheckbox.type = 'checkbox';
  enabledCheckbox.checked = cadence.enabled === true;
  enabledCheckbox.addEventListener('change', () => {
    cadence.enabled = enabledCheckbox.checked;
    renderFlowCadencePanel(flow);
    saveConfigDebounced();
  });
  enabledLabel.appendChild(enabledCheckbox);
  enabledLabel.appendChild(document.createTextNode(' ENABLE MID-SHOW AD CADENCE'));
  headerRow.appendChild(enabledLabel);

  const hint = document.createElement('span');
  hint.className = 'panel-status';
  hint.textContent = 'Runs breaks inside whatever content this flow is airing right now — every N minutes, or at set % points through a show/movie — on top of this flow\'s own step sequence above. Optionally limit it to specific tagged content below.';
  headerRow.appendChild(hint);

  container.appendChild(headerRow);

  if (!cadence.enabled) return;

  const grid = document.createElement('div');
  grid.className = 'field-grid';

  const timingSelect = document.createElement('select');
  timingSelect.className = 'block-hour-select';
  [
    ['everyNMinutes', 'EVERY N MINUTES'],
    ['breakpoints', 'AT SET POINTS (%)'],
  ].forEach(([value, label]) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    timingSelect.appendChild(opt);
  });
  timingSelect.value = cadence.timing || 'everyNMinutes';
  timingSelect.addEventListener('change', () => {
    cadence.timing = timingSelect.value;
    renderFlowCadencePanel(flow);
    saveConfigDebounced();
  });
  grid.appendChild(labeledField('TIMING', timingSelect));

  // Scopes mid-show cadence to only the currently-airing file's own tags
  // (setup-panels.js TITLES tab) — blank/unset (the default) applies it to
  // any content this flow already governs, same as before this field
  // existed. Lets one flow cover, say, both a tagged 'movie' and a tagged
  // 'short' without giving the short the same mid-show break cadence a
  // feature-length movie wants — the flow's own bumper/pod step sequence
  // above still applies to both either way; only these extra in-content
  // breaks are gated by this.
  const contentTagsInput = document.createElement('input');
  contentTagsInput.type = 'text';
  contentTagsInput.className = 'title-row-input';
  contentTagsInput.placeholder = 'e.g. movie, long-form';
  contentTagsInput.value = (cadence.contentTags || []).join(', ');
  contentTagsInput.addEventListener('change', () => {
    cadence.contentTags = contentTagsInput.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    saveConfigDebounced();
  });
  grid.appendChild(labeledField('APPLIES TO CONTENT TAGGED (BLANK = ANY)', attachTagAutocomplete(contentTagsInput), { wide: true }));

  if (cadence.timing === 'breakpoints') {
    const bpInput = document.createElement('input');
    bpInput.type = 'text';
    bpInput.className = 'title-row-input';
    bpInput.placeholder = 'e.g. 20, 45, 70';
    bpInput.value = (cadence.breakpoints || []).join(', ');
    bpInput.addEventListener('change', () => {
      const pts = bpInput.value.split(',')
        .map((v) => parseFloat(v.trim()))
        .filter((v) => Number.isFinite(v) && v > 0 && v < 100);
      cadence.breakpoints = pts;
      saveConfigDebounced();
      renderFlowCadencePanel(flow);
    });
    grid.appendChild(labeledField('BREAK POINTS (%)', bpInput));
    const track = buildBreakpointTrack(
      () => cadence.breakpoints,
      (pts) => { cadence.breakpoints = pts; saveConfigDebounced(); },
      bpInput,
    );
    grid.appendChild(labeledField('DRAG TO SET', track, { wide: true }));
  } else {
    const intervalInput = document.createElement('input');
    intervalInput.type = 'number';
    intervalInput.min = 1;
    intervalInput.className = 'block-priority-input';
    intervalInput.value = cadence.intervalMinutes || '';
    intervalInput.placeholder = '10';
    intervalInput.addEventListener('change', () => {
      cadence.intervalMinutes = parsePositiveInt(intervalInput.value, 10);
      saveConfigDebounced();
    });
    grid.appendChild(labeledField('EVERY (MIN)', intervalInput));
  }

  const podRow = document.createElement('div');
  podRow.className = 'block-card-row';
  const podMinInput = document.createElement('input');
  podMinInput.type = 'number';
  podMinInput.min = 1;
  podMinInput.className = 'block-priority-input';
  podMinInput.value = cadence.podMin || 1;
  podMinInput.addEventListener('change', () => {
    cadence.podMin = parsePositiveInt(podMinInput.value, 1);
    if ((cadence.podMax || 1) < cadence.podMin) {
      cadence.podMax = cadence.podMin;
      podMaxInput.value = cadence.podMax;
    }
    podMaxInput.min = cadence.podMin;
    saveConfigDebounced();
  });
  podRow.appendChild(podMinInput);
  const podSep = document.createElement('span');
  podSep.className = 'block-count';
  podSep.textContent = 'TO';
  podRow.appendChild(podSep);
  const podMaxInput = document.createElement('input');
  podMaxInput.type = 'number';
  podMaxInput.min = cadence.podMin || 1;
  podMaxInput.className = 'block-priority-input';
  podMaxInput.value = cadence.podMax || 1;
  podMaxInput.addEventListener('change', () => {
    cadence.podMax = Math.max(parsePositiveInt(podMaxInput.value, 1), cadence.podMin || 1);
    podMaxInput.value = cadence.podMax;
    saveConfigDebounced();
  });
  podRow.appendChild(podMaxInput);
  grid.appendChild(labeledField('SPOTS PER BREAK', podRow));

  const bumpInInput = document.createElement('input');
  bumpInInput.type = 'text';
  bumpInInput.className = 'title-row-input';
  bumpInInput.placeholder = 'e.g. network';
  bumpInInput.value = (cadence.bumpInTags || []).join(', ');
  bumpInInput.addEventListener('change', () => {
    cadence.bumpInTags = bumpInInput.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    updateCadenceMatchBadge();
    saveConfigDebounced();
  });
  grid.appendChild(labeledField(`BUMP-IN TAGS (matches pool: ${interstitialTypeDef('adBreakIn').label})`, attachTagAutocomplete(bumpInInput)));

  const commTagsInput = document.createElement('input');
  commTagsInput.type = 'text';
  commTagsInput.className = 'title-row-input';
  commTagsInput.placeholder = 'e.g. 90s-ads, toys';
  commTagsInput.value = (cadence.commercialTags || []).join(', ');
  commTagsInput.addEventListener('change', () => {
    cadence.commercialTags = commTagsInput.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    updateCadenceMatchBadge();
    saveConfigDebounced();
  });
  grid.appendChild(labeledField(`COMMERCIAL TAGS (matches pool: ${interstitialTypeDef('commercial').label})`, attachTagAutocomplete(commTagsInput)));

  const bumpOutInput = document.createElement('input');
  bumpOutInput.type = 'text';
  bumpOutInput.className = 'title-row-input';
  bumpOutInput.placeholder = 'e.g. show';
  bumpOutInput.value = (cadence.bumpOutTags || []).join(', ');
  bumpOutInput.addEventListener('change', () => {
    cadence.bumpOutTags = bumpOutInput.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    updateCadenceMatchBadge();
    saveConfigDebounced();
  });
  grid.appendChild(labeledField(`BUMP-OUT TAGS (matches pool: ${interstitialTypeDef('adBreakOut').label})`, attachTagAutocomplete(bumpOutInput)));

  // No badge at all here used to mean a cadence could be fully enabled with
  // tags that match zero real pool entries — hasMid computes true, the pod
  // silently builds empty, and nothing ever airs. This is the exact failure
  // a real live config hit (bump-in tag pointed at a pool entry that was
  // actually typed as a bump-OUT, and the commercial/bump-out tags fell back
  // to a content tag with no matching pool entries either).
  const cadenceMatchBadge = document.createElement('div');
  function updateCadenceMatchBadge() {
    renderPoolMatchBadge(cadenceMatchBadge, [
      { label: 'Bump-In', tags: cadence.bumpInTags, type: 'adBreakIn' },
      { label: 'Ads', tags: cadence.commercialTags, type: 'commercial' },
      { label: 'Bump-Out', tags: cadence.bumpOutTags, type: 'adBreakOut' },
    ], flow);
  }
  updateCadenceMatchBadge();
  grid.appendChild(labeledField('POOL COVERAGE', cadenceMatchBadge, { wide: true }));

  container.appendChild(grid);
}

export function normalizePoolType(type) {
  if (type === 'stationId') return 'channelId';
  if (type === 'bumpIn') return 'adBreakIn';   // legacy — still accepted
  if (type === 'bumpOut') return 'adBreakOut';  // legacy — still accepted
  if (type === 'ident') return 'ident';          // combined — see poolForIdent
  return type;
}


function updateFlowStatusBanner(flow) {
  const banner = document.getElementById('flow-status-banner');
  if (!banner) return;

  if (flow.enabled === false) {
    banner.className = 'flow-status-banner disabled';
    banner.textContent = `🚫 FLOW DISABLED — THIS TEMPLATE WILL BE SKIPPED DURING BROADCAST`;
    return;
  }

  banner.className = 'flow-status-banner';
  const chs = flow.channels || [];
  const chsStr = chs.length
    ? chs.map((n) => `CH ${String(n).padStart(2, '0')}`).join(', ')
    : 'ALL CHANNELS';

  const tags = flow.contentTags || [];
  const tagsStr = tags.length ? `#${tags.join(', #')}` : 'ANY SHOW';

  const stepCount = (flow.steps || []).length;
  banner.textContent = `⚡ FLOW ACTIVE FOR ${chsStr} // SHOWS: ${tagsStr} — ${stepCount} STEP${stepCount === 1 ? '' : 'S'} IN SEQUENCE`;
}

// `channels` (a flow's own flow.channels array) additionally narrows to
// entries this flow could actually use on one of its own channels — mirrors
// poolFor's own channelAffinity check (interstitials.js) so this editor-time
// "will this resolve to something?" preview agrees with what real playback
// will actually do. An empty/unset channels list means the flow applies to
// ALL channels, so there's no single affinity to check against — left
// unrestricted in that case (same as before this param existed). Without
// this, a pool entry locked to a channel this flow doesn't even cover could
// still count as a "match" here while poolFor rejects it for real — exactly
// the kind of false-positive ✓ that hid a real broken cadence setup once.
function matchingPoolEntries(tags, type, channels) {
  if (!tags || !tags.length) return [];
  const pool = (S.config.interstitials && S.config.interstitials.pool) || [];
  const targetType = normalizePoolType(type);
  // 'ident' draws from both adBreakIn and adBreakOut combined
  const matchTypes = targetType === 'ident' ? ['adBreakIn', 'adBreakOut'] : [targetType];
  return pool.filter((e) => {
    if (!matchTypes.includes(e.type)) return false;
    if (channels && channels.length && e.channelAffinity !== 'any' && !channels.includes(e.channelAffinity)) return false;
    return !tags.length || (e.contentTags && e.contentTags.some((t) => tags.includes(t)));
  });
}

function countMatchingPoolEntries(tags, type, channels) {
  const matches = matchingPoolEntries(tags, type, channels);
  return Array.isArray(matches) ? matches.length : 0;
}

// Shared match-count badge for any group of tag fields that resolve against
// the pool (an adPod step's bump-in/commercial/bump-out, the mid-show
// cadence panel's own three tag fields, or a single-type bumper step's tags)
// — factored out of what used to be two near-identical inline
// updateMatchBadge closures so the cadence panel (which previously had none
// at all) gets the same live feedback for free. `fields` is an array of
// { label, tags, type } — one row's worth of tags to check against one pool
// type each; `flow` supplies the channel-affinity scope (see
// matchingPoolEntries above).
function renderPoolMatchBadge(container, fields, flow) {
  const counts = fields.map((f) => ({ ...f, count: countMatchingPoolEntries(f.tags, f.type, flow && flow.channels) }));
  const good = counts.every((f) => f.count > 0 || !f.tags || !f.tags.length);
  container.className = `flow-match-badge ${good ? 'good' : 'warn'}`;
  container.textContent = `${good ? '✓' : '⚠️'} POOL MATCHES: ${counts.map((f) => `${f.label} (${f.count})`).join(' · ')}`;
}

function flowStepPreviewPaths(flow, step) {
  if (step.type === 'contentSegment') {
    const channelFilter = new Set(flow.channels || []);
    const tags = (step.tags && step.tags.length) ? step.tags : (flow.contentTags || []);
    const files = (S.config.channels || [])
      .filter((ch) => !channelFilter.size || channelFilter.has(ch.number))
      .flatMap((ch) => [
        ...(ch.files || []),
        ...(ch.blocks || []).flatMap((block) => block.files || []),
      ])
      .filter((file) => !tags.length || (file.tags || []).some((tag) => tags.includes(tag)));
    return files.map((file) => file.path).filter(Boolean);
  }

  let entries;
  if (step.type === 'adPod') {
    entries = [
      ...matchingPoolEntries(step.bumpInTags, 'adBreakIn', flow.channels),
      ...matchingPoolEntries(step.commercialTags, 'commercial', flow.channels),
      ...matchingPoolEntries(step.bumpOutTags, 'adBreakOut', flow.channels),
    ];
  } else {
    entries = matchingPoolEntries(step.tags, step.type, flow.channels);
  }
  return entries
    .map((entry) => (entry.file && entry.file.path) || (entry.bgFile && entry.bgFile.path))
    .filter(Boolean);
}

function renderFlowStepPreviews(container, flow, step) {
  container.innerHTML = '';
  const paths = Array.from(new Set(flowStepPreviewPaths(flow, step))).slice(0, 4);
  if (!paths.length) {
    container.appendChild(buildMediaThumbnail(null, {
      label: step.type === 'contentSegment' ? 'SHOW' : 'NONE',
      className: 'flow-step-thumbnail',
    }));
  } else {
    paths.forEach((path) => container.appendChild(buildMediaThumbnail(path, {
      label: 'MATCH',
      className: 'flow-step-thumbnail',
    })));
  }
}


function renderFlowTimelineCanvas(flow) {
  const canvas = document.getElementById('flow-timeline-canvas');
  if (!canvas) return;
  canvas.innerHTML = '';
  const stepCount = (flow.steps || []).length;
  canvas.setAttribute('role', 'region');
  canvas.setAttribute('aria-label', `${flow.name || 'Untitled flow'} sequence, ${stepCount} step${stepCount === 1 ? '' : 's'}. Scroll horizontally for later steps.`);

  if (!flow.steps || !flow.steps.length) {
    const empty = document.createElement('div');
    empty.className = 'titles-empty';
    empty.textContent = 'NO STEPS IN THIS FLOW YET. CLICK "+ BUMPER", "+ SHOW SEGMENT", OR "+ AD POD" ABOVE TO START BUILDING!';
    canvas.appendChild(empty);
    return;
  }

  flow.steps.forEach((step, idx) => {
    const card = document.createElement('div');
    let typeClass = 'type-bumper';
    if (step.type === 'contentSegment') typeClass = 'type-segment';
    else if (step.type === 'adPod') typeClass = 'type-pod';
    else if (step.type === 'stationId') typeClass = 'type-stationid';

    card.className = `flow-node-card ${typeClass}`;
    card.setAttribute('draggable', 'true');

    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(idx));
      card.classList.add('dragging');
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      document.querySelectorAll('.flow-node-card').forEach((c) => c.classList.remove('drag-over'));
    });

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      card.classList.add('drag-over');
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
    });

    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const srcIdxStr = e.dataTransfer.getData('text/plain');
      const srcIdx = parseInt(srcIdxStr, 10);
      if (!Number.isNaN(srcIdx) && srcIdx !== idx) {
        const [movedStep] = flow.steps.splice(srcIdx, 1);
        flow.steps.splice(idx, 0, movedStep);
        renderFlowTimelineCanvas(flow);
        saveConfigDebounced();
      }
    });

    const top = document.createElement('div');
    top.className = 'flow-node-top';

    const badge = document.createElement('span');
    badge.className = 'flow-step-badge';
    let typeLabel = 'BUMPER';
    if (step.type === 'contentSegment') typeLabel = 'SHOW SEGMENT 📺';
    else if (step.type === 'adPod') typeLabel = 'MID-ROLL AD POD 🍿';
    else if (step.type === 'stationId') typeLabel = 'STATION ID 📡';
    badge.textContent = `STEP ${idx + 1} · ${typeLabel}`;
    top.appendChild(badge);

    const controls = document.createElement('div');
    controls.className = 'flow-node-controls';

    const moveLeftBtn = document.createElement('button');
    moveLeftBtn.className = 'btn flow-btn-mini';
    moveLeftBtn.textContent = '◄';
    moveLeftBtn.disabled = idx === 0;
    moveLeftBtn.addEventListener('click', () => {
      [flow.steps[idx - 1], flow.steps[idx]] = [flow.steps[idx], flow.steps[idx - 1]];
      renderFlowTimelineCanvas(flow);
      saveConfigDebounced();
    });
    controls.appendChild(moveLeftBtn);

    const moveRightBtn = document.createElement('button');
    moveRightBtn.className = 'btn flow-btn-mini';
    moveRightBtn.textContent = '►';
    moveRightBtn.disabled = idx === flow.steps.length - 1;
    moveRightBtn.addEventListener('click', () => {
      [flow.steps[idx], flow.steps[idx + 1]] = [flow.steps[idx + 1], flow.steps[idx]];
      renderFlowTimelineCanvas(flow);
      saveConfigDebounced();
    });
    controls.appendChild(moveRightBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn remove-btn flow-btn-mini';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', () => {
      flow.steps.splice(idx, 1);
      updateFlowStatusBanner(flow);
      renderFlowTimelineCanvas(flow);
      saveConfigDebounced();
    });
    controls.appendChild(delBtn);

    top.appendChild(controls);
    card.appendChild(top);

    const previews = document.createElement('div');
    previews.className = 'flow-step-previews';
    previews.setAttribute('aria-label', 'Matching media previews');
    renderFlowStepPreviews(previews, flow, step);
    card.appendChild(previews);

    const body = document.createElement('div');
    body.className = 'flow-node-body';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'title-row-input';
    nameInput.placeholder = 'Step Name';
    nameInput.value = step.name || '';
    nameInput.addEventListener('input', () => {
      step.name = nameInput.value;
      saveConfigDebounced();
    });
    body.appendChild(labeledField('STEP LABEL', nameInput));

    if (step.type === 'contentSegment') {
      const tagInput = document.createElement('input');
      tagInput.type = 'text';
      tagInput.className = 'title-row-input';
      tagInput.placeholder = 'e.g. cartoon';
      tagInput.value = (step.tags || []).join(', ');
      tagInput.addEventListener('change', () => {
        step.tags = tagInput.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
        renderFlowStepPreviews(previews, flow, step);
        saveConfigDebounced();
      });
      body.appendChild(labeledField('SHOW TARGET TAGS', attachTagAutocomplete(tagInput)));
    } else if (step.type === 'adPod') {
      const bumpInInput = document.createElement('input');
      bumpInInput.type = 'text';
      bumpInInput.className = 'title-row-input';
      bumpInInput.placeholder = 'e.g. network';
      bumpInInput.value = (step.bumpInTags || []).join(', ');
      bumpInInput.addEventListener('change', () => {
        step.bumpInTags = bumpInInput.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
        updateMatchBadge();
        renderFlowStepPreviews(previews, flow, step);
        saveConfigDebounced();
      });
      body.appendChild(labeledField(`BUMP-IN IDENT TAGS (matches pool: ${interstitialTypeDef('adBreakIn').label})`, attachTagAutocomplete(bumpInInput)));

      const podRow = document.createElement('div');
      podRow.className = 'block-card-row';
      const minIn = document.createElement('input');
      minIn.type = 'number';
      minIn.setAttribute('aria-label', 'Minimum commercial spots');
      minIn.className = 'block-priority-input';
      minIn.value = step.podMin || 3;
      minIn.addEventListener('change', () => {
        step.podMin = parsePositiveInt(minIn.value, 1);
        if ((step.podMax || 1) < step.podMin) {
          step.podMax = step.podMin;
          maxIn.value = step.podMax;
        }
        saveConfigDebounced();
      });
      podRow.appendChild(minIn);
      const sep = document.createElement('span');
      sep.className = 'block-count';
      sep.textContent = 'TO';
      podRow.appendChild(sep);
      const maxIn = document.createElement('input');
      maxIn.type = 'number';
      maxIn.setAttribute('aria-label', 'Maximum commercial spots');
      maxIn.className = 'block-priority-input';
      maxIn.value = step.podMax || 4;
      maxIn.addEventListener('change', () => {
        step.podMax = Math.max(parsePositiveInt(maxIn.value, 1), step.podMin || 1);
        saveConfigDebounced();
      });
      podRow.appendChild(maxIn);
      const suf = document.createElement('span');
      suf.className = 'block-count';
      suf.textContent = 'COMMERCIAL SPOTS';
      podRow.appendChild(suf);
      body.appendChild(labeledField('COMMERCIAL POD SIZE', podRow));

      const commTagsIn = document.createElement('input');
      commTagsIn.type = 'text';
      commTagsIn.className = 'title-row-input';
      commTagsIn.placeholder = 'e.g. 90s-ads, toys';
      commTagsIn.value = (step.commercialTags || []).join(', ');
      commTagsIn.addEventListener('change', () => {
        step.commercialTags = commTagsIn.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
        updateMatchBadge();
        renderFlowStepPreviews(previews, flow, step);
        saveConfigDebounced();
      });
      body.appendChild(labeledField(`COMMERCIAL SPOTS TAGS (matches pool: ${interstitialTypeDef('commercial').label})`, attachTagAutocomplete(commTagsIn)));

      const bumpOutInput = document.createElement('input');
      bumpOutInput.type = 'text';
      bumpOutInput.className = 'title-row-input';
      bumpOutInput.placeholder = 'e.g. cartoon';
      bumpOutInput.value = (step.bumpOutTags || []).join(', ');
      bumpOutInput.addEventListener('change', () => {
        step.bumpOutTags = bumpOutInput.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
        updateMatchBadge();
        renderFlowStepPreviews(previews, flow, step);
        saveConfigDebounced();
      });
      body.appendChild(labeledField(`BUMP-OUT IDENT TAGS (matches pool: ${interstitialTypeDef('adBreakOut').label})`, attachTagAutocomplete(bumpOutInput)));

      const matchBadge = document.createElement('div');
      function updateMatchBadge() {
        renderPoolMatchBadge(matchBadge, [
          { label: 'Bump-In', tags: step.bumpInTags, type: 'adBreakIn' },
          { label: 'Ads', tags: step.commercialTags, type: 'commercial' },
          { label: 'Bump-Out', tags: step.bumpOutTags, type: 'adBreakOut' },
        ], flow);
      }
      updateMatchBadge();
      body.appendChild(matchBadge);
    } else {
      const typeSel = document.createElement('select');
      typeSel.className = 'block-hour-select';
      [
        ['upNext', 'UP NEXT IDENT'],
        ['ident', 'IDENT / BUMPER (BUMP-IN OR BUMP-OUT, EITHER)'],
        ['stationId', 'STATION ID'],
        ['promo', 'PROMO'],
        ['localAvail', 'LOCAL AVAIL / SPONSOR CARD'],
      ].forEach(([v, l]) => {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = l;
        typeSel.appendChild(opt);
      });
      typeSel.value = step.type || 'upNext';
      typeSel.addEventListener('change', () => {
        step.type = typeSel.value;
        renderFlowTimelineCanvas(flow);
        saveConfigDebounced();
      });
      body.appendChild(labeledField('BUMPER TYPE', typeSel));

      const tagInput = document.createElement('input');
      tagInput.type = 'text';
      tagInput.className = 'title-row-input';
      tagInput.placeholder = 'e.g. cartoon, network-intro';
      tagInput.value = (step.tags || []).join(', ');
      tagInput.addEventListener('change', () => {
        step.tags = tagInput.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
        updateMatchBadge();
        renderFlowStepPreviews(previews, flow, step);
        saveConfigDebounced();
      });
      body.appendChild(labeledField('BUMPER TAGS (matches the pool type selected above)', attachTagAutocomplete(tagInput)));

      const matchBadge = document.createElement('div');
      function updateMatchBadge() {
        // 'ident' already resolves against both adBreakIn+adBreakOut combined
        // via matchingPoolEntries' own normalizePoolType handling.
        const poolLabel = step.type === 'ident' ? 'Ident (bump-in or bump-out)' : interstitialTypeDef(normalizePoolType(step.type)).label;
        renderPoolMatchBadge(matchBadge, [{ label: poolLabel, tags: step.tags, type: step.type }], flow);
      }
      updateMatchBadge();
      body.appendChild(matchBadge);
    }

    card.appendChild(body);
    canvas.appendChild(card);

    if (idx < flow.steps.length - 1) {
      const conn = document.createElement('div');
      conn.className = 'flow-connector';
      conn.textContent = '➔';
      canvas.appendChild(conn);
    }
  });
}

function runFlowSimulator(flow) {
  const drawer = document.getElementById('flow-simulator-drawer');
  const progress = document.getElementById('flow-sim-progress');
  const output = document.getElementById('flow-sim-output');
  if (!drawer || !progress || !output) return;

  drawer.classList.remove('hidden');
  progress.innerHTML = '';
  output.innerHTML = '';

  flow.steps.forEach((s, idx) => {
    const chip = document.createElement('div');
    chip.className = `flow-sim-step step-${idx}`;
    chip.textContent = `STEP ${idx + 1}: ${s.name || s.type}`;
    progress.appendChild(chip);
  });

  // Every log line interpolates user-editable strings (flow/step names, pool
  // item text, tag lists) — building the log via innerHTML made those
  // injectable HTML. A shared channel-package/config file with a crafted
  // flow name (e.g. containing <img onerror=...>) would execute the moment
  // its simulator was run. One <div> per line via textContent sidesteps the
  // whole class of issue without needing to escape every call site above.
  function log(msg) {
    const line = document.createElement('div');
    line.textContent = msg;
    output.appendChild(line);
    output.scrollTop = output.scrollHeight;
  }

  const cadence = flow.cadence && flow.cadence.enabled ? flow.cadence : null;

  log(`[SIMULATOR] Starting flow simulation: "${flow.name}"`);
  log(`[SIMULATOR] Target content tags: #${(flow.contentTags || []).join(', #')}`);
  if (cadence) {
    const desc = cadence.timing === 'everyNMinutes'
      ? `every ${cadence.intervalMinutes || 10} min`
      : `at ${(cadence.breakpoints || []).join('%, ')}% points`;
    const scopeDesc = (cadence.contentTags && cadence.contentTags.length)
      ? `, only for content tagged #${cadence.contentTags.join(', #')}`
      : '';
    log(`[SIMULATOR] Mid-show ad cadence: ENABLED (${desc}, ${cadence.podMin || 1}-${cadence.podMax || cadence.podMin || 1} spots per break${scopeDesc})`);
  } else {
    log(`[SIMULATOR] Mid-show ad cadence: disabled`);
  }
  log(`------------------------------------------------------------`);

  // Assumed per-segment runtime for simulation purposes only, matching the
  // "(~11:00)" placeholder already shown on the SHOW SEGMENT log line below —
  // real playback uses the actual file duration (see resolveActiveCommercials/
  // resolveBreakAt's hasMid handling in schedule.js/interstitials.js), but the
  // simulator has no real media file to measure, so it picks a stand-in
  // duration long enough to demonstrate the configured cadence.
  const ASSUMED_SEGMENT_MIN = 11;

  // Mirrors computeActiveCommercials' own midTagsMatch gating (schedule.js):
  // an empty/unset cadence.contentTags applies to any segment; an UNTAGGED
  // segment (segmentTags.length === 0) is "unknown," not a known mismatch,
  // so it still gets cadence rather than silently losing it — only a
  // segment with real tags that share none with cadence.contentTags is
  // actually skipped.
  function cadenceAppliesToSegment(segmentTags) {
    if (!cadence.contentTags || !cadence.contentTags.length) return true;
    return segmentTags.length === 0 || cadence.contentTags.some((t) => segmentTags.includes(t));
  }

  function logCadenceBreaksForSegment(segmentTags) {
    if (!cadence) return;
    if (!cadenceAppliesToSegment(segmentTags)) {
      // Only reachable with real, non-overlapping tags — an untagged segment
      // always passes (see cadenceAppliesToSegment above).
      log(`  ⊘ MID-SHOW CADENCE: skipped — this segment's tags (#${segmentTags.join(', #')}) don't match the cadence's own scope (#${cadence.contentTags.join(', #')})`);
      return;
    }
    let breakTimesMin;
    if (cadence.timing === 'everyNMinutes') {
      const step = Math.max(1, cadence.intervalMinutes || 10);
      breakTimesMin = [];
      for (let t = step; t < ASSUMED_SEGMENT_MIN; t += step) breakTimesMin.push(t);
    } else {
      breakTimesMin = (cadence.breakpoints || [])
        .filter((p) => p > 0 && p < 100)
        .sort((a, b) => a - b)
        .map((p) => Math.round((p / 100) * ASSUMED_SEGMENT_MIN * 10) / 10);
    }
    if (!breakTimesMin.length) {
      log(`  ⚠ MID-SHOW CADENCE: no break falls within this segment's assumed runtime`);
      return;
    }
    const podMin = cadence.podMin || 1;
    const podMax = cadence.podMax || podMin;
    breakTimesMin.forEach((t) => {
      log(`  ┊ MID-SHOW AD BREAK @ ~${t}:00 into segment (${podMin}-${podMax} spots)`);
      // Uses matchingPoolEntries (same helper the live match badges use, and
      // channel-affinity-aware) instead of a bare pool.filter, so the
      // simulator's fallback lines below actually agree with whether a real
      // break would air — this is what let a real cadence "simulate clean"
      // while silently airing nothing (wrong pool type + no channel-eligible
      // commercials at all).
      const bumpIn = matchingPoolEntries(cadence.bumpInTags, 'adBreakIn', flow.channels)[0];
      if (bumpIn) log(`  ┊  ├─ BUMP-IN: "${bumpIn.text || (bumpIn.file && bumpIn.file.path) || 'Network Bump-In'}" (Tags: #${(cadence.bumpInTags || []).join(', #')})`);
      else log(`  ┊  ├─ BUMP-IN: [Synthetic Ident] "You're Watching Network" (Default — 0 pool matches for tag(s) #${(cadence.bumpInTags || []).join(', #') || '(none)'}, type ${interstitialTypeDef('adBreakIn').label} — check the pool editor)`);

      const commMatches = matchingPoolEntries(cadence.commercialTags, 'commercial', flow.channels);
      for (let s = 0; s < podMin; s++) {
        const comm = commMatches[s % Math.max(1, commMatches.length)];
        if (comm) log(`  ┊  ├─ COMMERCIAL ${s + 1}: "${comm.text || (comm.file && comm.file.path) || 'Retro Commercial'}" (30s)`);
        else log(`  ┊  ├─ COMMERCIAL ${s + 1}: [Default Commercial Spot ${s + 1}] (30s — 0 pool matches for tag(s) #${(cadence.commercialTags || []).join(', #') || '(none)'}, type ${interstitialTypeDef('commercial').label} — check the pool editor)`);
      }

      const bumpOut = matchingPoolEntries(cadence.bumpOutTags, 'adBreakOut', flow.channels)[0];
      if (bumpOut) log(`  ┊  └─ BUMP-OUT: "${bumpOut.text || (bumpOut.file && bumpOut.file.path) || 'Back to Show Bumper'}" (Tags: #${(cadence.bumpOutTags || []).join(', #')})`);
      else log(`  ┊  └─ BUMP-OUT: [Synthetic Ident] "Back to the Show" (Default — 0 pool matches for tag(s) #${(cadence.bumpOutTags || []).join(', #') || '(none)'}, type ${interstitialTypeDef('adBreakOut').label} — check the pool editor)`);
    });
  }

  let currentStepIdx = 0;
  function stepTick() {
    if (currentStepIdx >= flow.steps.length) {
      log(`------------------------------------------------------------`);
      log(`✓ [SIMULATOR COMPLETE] All ${flow.steps.length} sequence steps resolved cleanly! Flow is ready for live broadcast.`);
      return;
    }

    const step = flow.steps[currentStepIdx];
    const chips = progress.querySelectorAll('.flow-sim-step');
    chips.forEach((c, i) => c.classList.toggle('active', i === currentStepIdx));

    if (step.type === 'contentSegment') {
      const segmentTags = (step.tags && step.tags.length ? step.tags : flow.contentTags) || [];
      log(`▶ STEP ${currentStepIdx + 1} [SHOW SEGMENT]: "${step.name}" -> Airing show episode matching #${segmentTags.join(', #')} (~${ASSUMED_SEGMENT_MIN}:00)`);
      logCadenceBreaksForSegment(segmentTags);
    } else if (step.type === 'adPod') {
      log(`▶ STEP ${currentStepIdx + 1} [AD POD BREAK]: "${step.name}" (${step.podMin}-${step.podMax} spots)`);
      const bumpIn = matchingPoolEntries(step.bumpInTags, 'adBreakIn', flow.channels)[0];
      if (bumpIn) log(`  ├─ BUMP-IN: "${bumpIn.text || (bumpIn.file && bumpIn.file.path) || 'Network Bump-In'}" (Tags: #${(step.bumpInTags || []).join(', #')})`);
      else log(`  ├─ BUMP-IN: [Synthetic Ident] "You're Watching Network" (Default — 0 pool matches for tag(s) #${(step.bumpInTags || []).join(', #') || '(none)'}, type ${interstitialTypeDef('adBreakIn').label} — check the pool editor)`);

      const spotCount = step.podMin || 3;
      const commMatches = matchingPoolEntries(step.commercialTags, 'commercial', flow.channels);
      for (let i = 0; i < spotCount; i++) {
        const comm = commMatches[i % Math.max(1, commMatches.length)];
        if (comm) log(`  ├─ COMMERCIAL ${i + 1}: "${comm.text || (comm.file && comm.file.path) || 'Retro Commercial'}" (30s)`);
        else log(`  ├─ COMMERCIAL ${i + 1}: [Default Commercial Spot ${i + 1}] (30s — 0 pool matches for tag(s) #${(step.commercialTags || []).join(', #') || '(none)'}, type ${interstitialTypeDef('commercial').label} — check the pool editor)`);
      }

      const bumpOut = matchingPoolEntries(step.bumpOutTags, 'adBreakOut', flow.channels)[0];
      if (bumpOut) log(`  └─ BUMP-OUT: "${bumpOut.text || (bumpOut.file && bumpOut.file.path) || 'Back to Show Bumper'}" (Tags: #${(step.bumpOutTags || []).join(', #')})`);
      else log(`  └─ BUMP-OUT: [Synthetic Ident] "Back to the Show" (Default — 0 pool matches for tag(s) #${(step.bumpOutTags || []).join(', #') || '(none)'}, type ${interstitialTypeDef('adBreakOut').label} — check the pool editor)`);
    } else {
      const item = matchingPoolEntries(step.tags, step.type, flow.channels)[0];
      const label = step.type === 'ident' ? 'IDENT/BUMPER' : step.type.toUpperCase();
      if (item) log(`▶ STEP ${currentStepIdx + 1} [${label}]: "${step.name}" → Resolved "${item.text || (item.file && item.file.path) || 'Bumper File'}" (Tags: #${(step.tags || []).join(', #')})`);
      else log(`▶ STEP ${currentStepIdx + 1} [${label}]: "${step.name}" → [Generated ${label} Card] (0 pool matches for tag(s) #${(step.tags || []).join(', #') || '(none)'}, type ${step.type === 'ident' ? 'Ident (bump-in or bump-out)' : interstitialTypeDef(normalizePoolType(step.type)).label} — check the pool editor)`);
    }

    currentStepIdx++;
    setTimeout(stepTick, 400);
  }

  stepTick();
}

export function initFlowBuilder() {
  const selectEl = document.getElementById('flow-template-select');
  const createBtn = document.getElementById('flow-create-btn');
  const deleteBtn = document.getElementById('flow-delete-btn');
  const nameInput = document.getElementById('flow-name-input');
  const enabledCheckbox = document.getElementById('flow-enabled-checkbox');
  const addBumperBtn = document.getElementById('flow-add-bumper-btn');
  const addSegmentBtn = document.getElementById('flow-add-segment-btn');
  const addPodBtn = document.getElementById('flow-add-pod-btn');
  const addStationIdBtn = document.getElementById('flow-add-stationid-btn');
  const simBtn = document.getElementById('flow-sim-btn');
  const simCloseBtn = document.getElementById('flow-sim-close-btn');

  if (selectEl) {
    selectEl.addEventListener('change', () => {
      activeFlowId = selectEl.value;
      renderFlowsList();
    });
  }

  if (createBtn) {
    createBtn.addEventListener('click', () => {
      ensureFlowsConfig();
      const newFlow = {
        id: `flow-${Date.now()}`,
        name: 'New Custom Show Flow',
        enabled: true,
        contentTags: ['custom-show'],
        steps: [
          { id: `s-${Date.now()}-1`, type: 'upNext', name: 'Intro Bumper', tags: ['intro'] },
          { id: `s-${Date.now()}-2`, type: 'contentSegment', name: 'Episode Part 1 (~11 min)', tags: ['custom-show'] },
          { id: `s-${Date.now()}-3`, type: 'adPod', name: 'Mid-Roll Ad Pod', podMin: 3, podMax: 4, bumpInTags: ['network'], commercialTags: ['retro-ads'], bumpOutTags: ['custom-show'] },
          { id: `s-${Date.now()}-4`, type: 'contentSegment', name: 'Episode Part 2 (~11 min)', tags: ['custom-show'] },
          { id: `s-${Date.now()}-5`, type: 'stationId', name: 'Station ID / Outro', tags: ['station-id'] }
        ]
      };
      S.config.interstitials.flows.push(newFlow);
      activeFlowId = newFlow.id;
      renderFlowsList();
      saveConfigDebounced();
    });
  }

  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      ensureFlowsConfig();
      const flows = S.config.interstitials.flows;
      if (flows.length <= 1) {
        alertDialog('Cannot delete the last flow template.');
        return;
      }
      const activeFlow = flows.find((f) => f.id === activeFlowId);
      if (!(await confirmDialog(`Delete flow "${activeFlow ? activeFlow.name : 'untitled'}"?`))) return;
      const idx = flows.findIndex((f) => f.id === activeFlowId);
      if (idx !== -1) flows.splice(idx, 1);
      activeFlowId = flows[0] ? flows[0].id : null;
      renderFlowsList();
      saveConfigDebounced();
    });
  }

  if (nameInput) {
    nameInput.addEventListener('input', () => {
      ensureFlowsConfig();
      const activeFlow = S.config.interstitials.flows.find((f) => f.id === activeFlowId);
      if (activeFlow) {
        activeFlow.name = nameInput.value;
        const opt = selectEl ? selectEl.querySelector(`option[value="${activeFlow.id}"]`) : null;
        if (opt) opt.textContent = activeFlow.name || '(untitled flow)';
        saveConfigDebounced();
      }
    });
  }

  if (enabledCheckbox) {
    enabledCheckbox.addEventListener('change', () => {
      ensureFlowsConfig();
      const activeFlow = S.config.interstitials.flows.find((f) => f.id === activeFlowId);
      if (activeFlow) {
        activeFlow.enabled = enabledCheckbox.checked;
        updateFlowStatusBanner(activeFlow);
        saveConfigDebounced();
      }
    });
  }

  const addStep = (type, defaultName, defaultTags) => {
    ensureFlowsConfig();
    const activeFlow = S.config.interstitials.flows.find((f) => f.id === activeFlowId);
    if (!activeFlow) return;
    if (!activeFlow.steps) activeFlow.steps = [];
    const step = {
      id: `step-${Date.now()}`,
      type,
      name: defaultName,
      tags: defaultTags
    };
    if (type === 'adPod') {
      step.podMin = 3;
      step.podMax = 4;
      step.bumpInTags = ['network'];
      step.commercialTags = ['retro-ads'];
      step.bumpOutTags = [activeFlow.contentTags[0] || 'show'];
    }
    activeFlow.steps.push(step);
    updateFlowStatusBanner(activeFlow);
    renderFlowTimelineCanvas(activeFlow);
    saveConfigDebounced();
  };

  addBumperBtn && addBumperBtn.addEventListener('click', () => addStep('upNext', 'Coming Up Next Bumper', ['intro']));
  addSegmentBtn && addSegmentBtn.addEventListener('click', () => addStep('contentSegment', 'Show Segment', ['show']));
  addPodBtn && addPodBtn.addEventListener('click', () => addStep('adPod', 'Mid-Roll Commercial Pod', []));
  addStationIdBtn && addStationIdBtn.addEventListener('click', () => addStep('stationId', 'Station ID / Outro', ['station-id']));

  simBtn && simBtn.addEventListener('click', () => {
    ensureFlowsConfig();
    const activeFlow = S.config.interstitials.flows.find((f) => f.id === activeFlowId);
    if (activeFlow) runFlowSimulator(activeFlow);
  });

  simCloseBtn && simCloseBtn.addEventListener('click', () => {
    const drawer = document.getElementById('flow-simulator-drawer');
    if (drawer) drawer.classList.add('hidden');
  });
}
