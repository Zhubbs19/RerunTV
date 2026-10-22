// Heuristic guard for HTML built from template literals in plugin UI code.
//
// A plugin that writes `el.innerHTML = `...${value}...`` with a value that can
// hold text from outside the plugin (a title, a file name, a station name, an
// error message, a remote string) lets that text become markup. Wrap such
// values in escapeHtml() (ctx.ui.escapeHtml, or the plugin's own local copy)
// or build the node with textContent.
//
// This scans plugins/*/*.js for innerHTML / insertAdjacentHTML assignments from
// a template literal, then looks at every ${...} interpolation. Anything inside
// an escaper call, a string literal or a nested template's static text is
// ignored; if what remains mentions a name that usually carries free text
// (name, title, label, path, message, ...) it is reported. It is a heuristic, so
// a site proven safe (a hard-coded label, a number formatted just above) goes in
// VERIFIED_SAFE as `<file>: <expression>` with the reason noted beside it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGINS_DIR = path.join(__dirname, '..', 'plugins');
const BS = String.fromCharCode(92);
const ESCAPERS = /^(escapeHtml|escapeHTML|esc|attr|escapeAttr|ctx\.ui\.escapeHtml|ui\.escapeHtml)$/;
const FREE_TEXT = /(^|[^\w$])(name|title|label|text|message|description|error|headline|summary|reason|artist|album|path|folder|folderPath|station|channelName|filename|fileName|source|caption|body|detail)([^\w$]|$)/i;

// Verified-safe interpolations, keyed `<plugin>/<file>: <trimmed expression>`.
const VERIFIED_SAFE = new Set([
  // SEARCH_TABS is a constant table of tab ids and labels
  "digital-music-channel/renderer.js: SEARCH_TABS.map((t) => `<span class=\"mc-browser-tab\" data-tab=\"${t.id}\">${t.label}</span>`).join('')",
  // a disabled-attribute switch or a computed count/duration, no stored text
  "digital-music-channel/settings.js: station.folderPath ? '' : 'disabled'",
  // a disabled-attribute switch or a computed count/duration, no stored text
  "digital-music-channel/settings.js: (station.tracks || []).length",
  // a disabled-attribute switch or a computed count/duration, no stored text
  "digital-music-channel/settings.js: totalDuration(station)",
  // a disabled-attribute switch or a computed count/duration, no stored text
  "digital-music-channel/settings.js: ((station.background && station.background.images) || []).length",
  // the condition reads status.error; the message itself is escaped inside the branch
  "makemkv/settings.js: !status.blocked && status.error ? `<span class=\"panel-status\">MakeMKV could not be started: ${escapeHtml(status.error)}<",
  // user text is escaped where it is printed (escapeHtml(label) / escapeHtml(title.title)); the flagged part is the map source
  "tape-deck/renderer.js: ['PLAY FROM START'].concat(chapters.map((c) => c.label || 'CHAPTER')).map((label, i) => ` <li class=\"tape-chapter${i ===",
  // labels come from constant tables (MODE_LABELS, ART_SLOTS) or the service slot list; stored text is escaped where printed
  "tape-deck/settings.js: slots.map(({ id, label, defaultMs }) => { const entry = chosen[id] || {}; return ` <div class=\"panel-interval\" data-slot",
  // labels come from constant tables (MODE_LABELS, ART_SLOTS) or the service slot list; stored text is escaped where printed
  "tape-deck/settings.js: tapes.map((tape) => ` <div class=\"panel-body\" data-tape=\"${escapeHtml(tape.id)}\" style=\"margin-bottom:10px\"> <div class=",
  // labels come from constant tables (MODE_LABELS, ART_SLOTS) or the service slot list; stored text is escaped where printed
  "tape-deck/settings.js: MODE_LABELS.map(([id, label]) => `<option value=\"${id}\">${label}</option>`).join('')",
]);

function skipString(text, i) {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length && text[j] !== quote) { if (text[j] === BS) j += 1; j += 1; }
  return j + 1;
}

// The identifiers left in an expression once escaper calls, string literals and
// nested-template static text are removed.
function residue(expr) {
  // Arrow-function parameter lists only name things; they carry no text themselves.
  expr = expr.replace(/\(([^()]*)\)\s*=>/g, ' ').replace(/\b[A-Za-z_$][\w$]*\s*=>/g, ' ');
  let out = '';
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === "'" || ch === '"') { i = skipString(expr, i); out += ' '; continue; }
    if (ch === '`') {
      i += 1;
      while (i < expr.length && expr[i] !== '`') {
        if (expr[i] === BS) { i += 2; continue; }
        if (expr[i] === '$' && expr[i + 1] === '{') {
          let depth = 1;
          let j = i + 2;
          while (j < expr.length && depth) {
            if (expr[j] === '{') depth += 1;
            else if (expr[j] === '}') depth -= 1;
            else if (expr[j] === '`' || expr[j] === "'" || expr[j] === '"') {
              if (expr[j] === '`') { j += 1; while (j < expr.length && expr[j] !== '`') { if (expr[j] === BS) j += 1; j += 1; } } else { j = skipString(expr, j) - 1; }
            }
            j += 1;
          }
          out += ` ${residue(expr.slice(i + 2, j - 1))} `;
          i = j;
        } else i += 1;
      }
      i += 1;
      continue;
    }
    const call = /^([A-Za-z_$][\w$.]*)\(/.exec(expr.slice(i));
    if (call && (i === 0 || !/[\w$.]/.test(expr[i - 1])) && ESCAPERS.test(call[1])) {
      let depth = 1;
      let j = i + call[0].length;
      while (j < expr.length && depth) {
        if (expr[j] === '(') depth += 1;
        else if (expr[j] === ')') depth -= 1;
        else if (expr[j] === "'" || expr[j] === '"') j = skipString(expr, j) - 1;
        j += 1;
      }
      i = j;
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function templateInterpolations(text) {
  const found = [];
  const re = /(innerHTML\s*\+?=|insertAdjacentHTML\([^,]+,)\s*`/g;
  let m;
  while ((m = re.exec(text))) {
    let i = m.index + m[0].length;
    const line = text.slice(0, m.index).split('\n').length;
    while (i < text.length) {
      const ch = text[i];
      if (ch === BS) { i += 2; continue; }
      if (ch === '`') break;
      if (ch === '$' && text[i + 1] === '{') {
        let depth = 1;
        let j = i + 2;
        while (j < text.length && depth) {
          const c = text[j];
          if (c === '{') depth += 1;
          else if (c === '}') depth -= 1;
          else if (c === '`') { j += 1; while (j < text.length && text[j] !== '`') { if (text[j] === BS) j += 1; j += 1; } } else if (c === "'" || c === '"') j = skipString(text, j) - 1;
          j += 1;
        }
        found.push({ line, expr: text.slice(i + 2, j - 1).replace(/\s+/g, ' ').trim() });
        i = j;
        continue;
      }
      i += 1;
    }
  }
  return found;
}

function scan() {
  const findings = [];
  for (const dir of fs.readdirSync(PLUGINS_DIR)) {
    const root = path.join(PLUGINS_DIR, dir);
    if (!fs.statSync(root).isDirectory()) continue;
    for (const name of fs.readdirSync(root).filter((n) => n.endsWith('.js'))) {
      const text = fs.readFileSync(path.join(root, name), 'utf8');
      for (const { line, expr } of templateInterpolations(text)) {
        if (!FREE_TEXT.test(residue(expr))) continue;
        const key = `${dir}/${name}: ${expr.slice(0, 120)}`;
        if (!VERIFIED_SAFE.has(key)) findings.push(`${key}   (line ${line})`);
      }
    }
  }
  return findings;
}

test('plugin innerHTML templates escape free-text interpolations', () => {
  assert.deepEqual(scan(), [], 'Wrap these in escapeHtml() (ctx.ui.escapeHtml) or add a reasoned entry to VERIFIED_SAFE.');
});

test('the scanner flags an unescaped label and accepts an escaped one', () => {
  const bad = 'el.innerHTML = `<b>${item.label}</b>`;';
  const good = 'el.innerHTML = `<b>${escapeHtml(item.label)}</b>`;';
  assert.equal(templateInterpolations(bad).filter(({ expr }) => FREE_TEXT.test(residue(expr))).length, 1);
  assert.equal(templateInterpolations(good).filter(({ expr }) => FREE_TEXT.test(residue(expr))).length, 0);
});

module.exports = { scan };
