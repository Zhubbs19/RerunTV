// The single rule stack — docs/design/02 §5, step 3a. A channel's programming
// as ONE ordered list of rules instead of seven layers:
//
//   programming = {
//     signOff: { hours: [offHour, onHour] } | null,
//     rules: [ { id, when, play?, breaks? }, … ],   // top-down
//   }
//
// Resolution walks the list top-down twice, independently: the first matching
// rule that says what to PLAY decides content, and the first matching rule
// that says what BREAKS to run decides the ad policy. A rule may set only one
// of the two, and the other falls through to the rules below (§5.1).
//
// Step 3a changes no saved config. rulesFromLayers() translates a channel's
// existing layers into this shape in memory, the resolvers below answer the
// same questions resolveActiveSource / resolveActiveCommercials /
// isWithinBroadcastHours answer, and compareRulesToLayers() checks the two
// agree at every instant a schedule can change. That comparison is the safety
// net §5.3 requires before any migration writes config, and it runs against
// the real lineup (scratch test/verify-rules-equivalence.mjs).
//
// What airs inside a matching block (loop, daily/weekly runs, day overrides,
// finale) is the block's own business and is played through schedule.js's
// sourceFromBlock, so the rules only decide ORDER and WHEN. Pure: no DOM, and
// every instant is a parameter.
import { effectiveContentTags } from './interstitials.js';
import {
  flowCommercials, hourInRange, isWithinBroadcastHours, resolveActiveCommercials,
  resolveActiveSource, sourceFromBlock,
} from './schedule.js';

const DAY_MS = 86400000;

function pad2(n) {
  return String(n).padStart(2, '0');
}

// ---------- when ----------
// 'always'
// { hours: [start, end], days?: [0-6] }                 a time slot (hours wrap midnight; start === end is all day)
// { dates: ['MM-DD', 'MM-DD'], hours?: [s, e], days? }   a calendar range, optionally narrowed
// { tags: [...], untagged: 'matches' | 'excluded' }      the airing file's tags (for break rules)

function whenFromTrigger(t) {
  if (t.type === 'dateRange') {
    const when = { dates: [`${pad2(t.startMonth)}-${pad2(t.startDay)}`, `${pad2(t.endMonth)}-${pad2(t.endDay)}`] };
    if (t.startHour != null && t.endHour != null) when.hours = [t.startHour, t.endHour];
    if (t.days && t.days.length) when.days = [...t.days];
    return when;
  }
  const when = { hours: [t.startHour, t.endHour] };
  if (t.days && t.days.length) when.days = [...t.days];
  return when;
}

// Month/day ordering in a leap reference year, as schedule.js's inDateRange
// does, so Feb 29 and ranges wrapping New Year compare the same way.
function mdOrdinal(month, day) {
  return new Date(2000, month - 1, day).getTime();
}

function inDates(atMs, [from, to]) {
  const d = new Date(atMs);
  const [fm, fd] = from.split('-').map(Number);
  const [tm, td] = to.split('-').map(Number);
  const cur = mdOrdinal(d.getMonth() + 1, d.getDate());
  const start = mdOrdinal(fm, fd);
  const end = mdOrdinal(tm, td);
  return start <= end ? (cur >= start && cur <= end) : (cur >= start || cur <= end);
}

export function matchesWhen(when, atMs, fileTags = []) {
  if (when === 'always') return true;
  if (!when || typeof when !== 'object') return false;
  if (when.tags) {
    if (!when.tags.length) return true;
    if (!fileTags.length) return when.untagged === 'matches';
    return when.tags.some((t) => fileTags.includes(t));
  }
  const d = new Date(atMs);
  if (when.dates && !inDates(atMs, when.dates)) return false;
  if (when.days && when.days.length && !when.days.includes(d.getDay())) return false;
  if (when.hours && !hourInRange(d.getHours(), { startHour: when.hours[0], endHour: when.hours[1] })) return false;
  return true;
}

// ---------- translation ----------

// The rule order that reproduces today's layers exactly:
//   ads off (if the channel's ads switch is off)    breaks only
//   flows that can apply to this channel, in order  breaks only
//   presets that can apply, in order                breaks only
//   blocks, highest priority first (ties by order)  play, plus breaks when the block has its own ads
//   the default lineup and cadence                  play + breaks
// Content rules and break rules keep their own relative orders, which is all
// first-match-per-kind resolution needs.
//
// Flows and presets are box-wide lists. A channel's rules name the ones whose
// channel scope includes it at translation time; their tag scope stays in the
// rule. That snapshot is the design question step 3b has to settle (§5.4).
export function rulesFromLayers(ch, config) {
  const rules = [];
  const n = ch.number;
  if (ch.adsEnabled === false) rules.push({ id: 'ads-off', when: 'always', breaks: { off: true } });

  const interstitials = (config && config.interstitials) || {};
  (interstitials.flows || []).forEach((f) => {
    if (f.enabled === false) return;
    if (f.channels && f.channels.length && !f.channels.includes(n)) return;
    rules.push({ id: `flow:${f.id}`, when: { tags: [...(f.contentTags || [])], untagged: 'matches' }, breaks: { flow: f.id } });
  });
  (interstitials.presets || []).forEach((p) => {
    if (p.enabled === false) return;
    const channelScoped = p.channels && p.channels.length;
    const tagScoped = p.contentTags && p.contentTags.length;
    if (!channelScoped && !tagScoped) return;
    if (channelScoped && !p.channels.includes(n)) return;
    rules.push({ id: `preset:${p.id}`, when: { tags: [...(p.contentTags || [])], untagged: 'excluded' }, breaks: { preset: p.id } });
  });

  (ch.blocks || [])
    .map((b, idx) => ({ b, idx }))
    .filter(({ b }) => b && b.trigger)
    .sort((x, y) => (y.b.priority || 0) - (x.b.priority || 0) || x.idx - y.idx)
    .forEach(({ b }) => {
      const rule = { id: `block:${b.id}`, when: whenFromTrigger(b.trigger), play: { block: b.id } };
      if (b.commercials) rule.breaks = { block: b.id };
      rules.push(rule);
    });

  rules.push({ id: 'default', when: 'always', play: { lineup: true }, breaks: { cadence: true } });

  const bh = ch.broadcastHours;
  // On the air [start, end) is off the air [end, start); start === end means
  // on the air around the clock, so there's nothing to sign off.
  const signOff = bh && bh.enabled && bh.startHour !== bh.endHour ? { hours: [bh.endHour, bh.startHour] } : null;
  return { signOff, rules };
}

// ---------- resolution ----------

export function rulesOnAir(programming, atMs) {
  const off = programming.signOff;
  if (!off) return true;
  return !hourInRange(new Date(atMs).getHours(), { startHour: off.hours[0], endHour: off.hours[1] });
}

function findBlock(ch, id) {
  return (ch.blocks || []).find((b) => b && b.id === id) || null;
}

// The same { files, anchor, key, block } shape resolveActiveSource returns.
export function rulesSource(ch, programming, atMs) {
  for (const rule of programming.rules) {
    if (!rule.play || !matchesWhen(rule.when, atMs)) continue;
    if (rule.play.lineup) return { files: ch.files, anchor: ch.anchor, key: -1, block: null };
    const block = findBlock(ch, rule.play.block);
    if (!block || !block.files || !block.files.length) continue; // nothing to play: fall through
    const source = sourceFromBlock(block, atMs);
    if (source) return source;
  }
  return { files: ch.files, anchor: ch.anchor, key: -1, block: null };
}

// The same { commercials, key } shape resolveActiveCommercials returns.
export function rulesCommercials(ch, programming, config, atMs, fileTags = []) {
  const interstitials = (config && config.interstitials) || {};
  for (const rule of programming.rules) {
    if (!rule.breaks || !matchesWhen(rule.when, atMs, fileTags)) continue;
    const b = rule.breaks;
    if (b.off) return { commercials: { enabled: false }, key: 'disabled' };
    if (b.flow) {
      const flow = (interstitials.flows || []).find((f) => f.id === b.flow);
      if (flow) return flowCommercials(flow, fileTags);
      continue;
    }
    if (b.preset) {
      const preset = (interstitials.presets || []).find((p) => p.id === b.preset);
      if (preset) return { commercials: preset, key: `preset:${preset.id}` };
      continue;
    }
    if (b.block) {
      const block = findBlock(ch, b.block);
      if (block && block.commercials) return { commercials: block.commercials, key: block.id };
      continue;
    }
    if (b.cadence) {
      const globalCc = (config && config.commercials) || {};
      return { commercials: ch.commercials || { ...globalCc, enabled: true }, key: -1 };
    }
  }
  const globalCc = (config && config.commercials) || {};
  return { commercials: ch.commercials || { ...globalCc, enabled: true }, key: -1 };
}

// ---------- equivalence ----------

function localHourStarts(from, to) {
  const out = [];
  const d = new Date(from);
  d.setMinutes(0, 0, 0);
  while (d.getTime() < to) {
    if (d.getTime() >= from) out.push(d.getTime());
    d.setHours(d.getHours() + 1);
  }
  return out;
}

// Every instant in [from, to) at which what a channel resolves to can change:
// triggers and broadcast hours move only on the hour, a daily block's day can
// unlock at its own minute, and a weekly run changes at its window's start
// hour — so the hour starts, the half hours, and each unlock minute cover it.
export function decisionInstants(ch, from, to) {
  const instants = new Set();
  localHourStarts(from, to).forEach((t) => { instants.add(t); instants.add(t + 30 * 60000); instants.add(t + 3600000 - 1); });
  const unlocks = new Set();
  (ch.blocks || []).forEach((b) => Object.values((b && b.dayOverrides) || {}).forEach((ov) => { if (ov && ov.unlockTime) unlocks.add(ov.unlockTime); }));
  if (unlocks.size) {
    for (let day = new Date(from).setHours(0, 0, 0, 0); day < to; day += DAY_MS) {
      unlocks.forEach((hhmm) => {
        const [h, m] = hhmm.split(':').map(Number);
        const t = new Date(day).setHours(h || 0, m || 0, 0, 0);
        [t - 1, t].forEach((x) => { if (x >= from && x < to) instants.add(x); });
      });
    }
  }
  return [...instants].sort((a, b) => a - b);
}

// Every distinct tag list an airing on this channel can carry, as the ad
// resolvers see it (file tags plus the channel's own content tags).
export function tagSetsFor(ch) {
  const sets = new Map([['', effectiveContentTags(ch, null)]]);
  const add = (file) => {
    const tags = effectiveContentTags(ch, file);
    sets.set(tags.join('|'), tags);
  };
  (ch.files || []).forEach(add);
  (ch.blocks || []).forEach((b) => ((b && b.files) || []).forEach(add));
  return [...sets.values()];
}

// Compares the rule stack against today's resolvers over [from, to). The
// layered resolvers read S.config (the caller's config must be it). Returns
// { instants, checks, mismatches: [{ atMs, what, layers, rules }] } with at
// most `limit` mismatches listed.
export function compareRulesToLayers(ch, config, from, to, { limit = 20 } = {}) {
  const programming = rulesFromLayers(ch, config);
  const instants = decisionInstants(ch, from, to);
  const tagSets = tagSetsFor(ch);
  const mismatches = [];
  let checks = 0;
  const note = (atMs, what, layers, rules) => { if (mismatches.length < limit) mismatches.push({ atMs, what, layers, rules }); };
  for (const t of instants) {
    checks++;
    if (isWithinBroadcastHours(ch, t) !== rulesOnAir(programming, t)) note(t, 'onAir', isWithinBroadcastHours(ch, t), rulesOnAir(programming, t));
    const a = resolveActiveSource(ch, t);
    const b = rulesSource(ch, programming, t);
    if (a.key !== b.key || a.anchor !== b.anchor || a.block !== b.block || a.files.length !== b.files.length || a.files[0] !== b.files[0]) {
      note(t, 'source', a.key, b.key);
    }
    for (const tags of tagSets) {
      checks++;
      const x = resolveActiveCommercials(ch, t, tags);
      const y = rulesCommercials(ch, programming, config, t, tags);
      if (x.key !== y.key || JSON.stringify(x.commercials) !== JSON.stringify(y.commercials)) note(t, `commercials [${tags.join(',')}]`, x.key, y.key);
    }
  }
  return { rules: programming.rules.length, instants: instants.length, checks, mismatches };
}
