// A fast drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build
// returns for the same input: every page's index.html, the index and tag
// pages, build-report.txt and each static file, byte for byte.
//
// The dialect is makefun-site's own (front matter, template dialect,
// Markdown subset, slug rule, report); this file reimplements it from
// scratch, optimised for speed:
//
//   - the hot scans run in the regex engine (C++), not in per-character
//     JavaScript loops: one regex scan finds the next inline or HTML
//     special, so plain text is pushed whole with no escaping at all,
//     and words are counted with one /\S+/g scan per line;
//   - Markdown is rendered straight from the source's line array into a
//     parts array joined once; no token arrays, no intermediate strings;
//   - each template is compiled once to a node tree; rendering walks the
//     tree into a parts array, reusing one scope frame and one loop
//     object per loop instead of allocating per element;
//   - a template whose output depends only on the case-global values
//     (site, tags, recent) is rendered once per case and reused, and a
//     template depending on a single other value is memoised per that
//     value (per include depth, so the depth-8 include cap stays exact);
//   - slugify, longDate and relative-path resolution are memoised per
//     case; the ASCII fast path of slugify skips Unicode normalisation
//     entirely, and line ends are only rewritten when a "\r" is present.
//
// Nothing is cached across cases: every run() builds fresh per-case
// state, so each case is answered alone from its own input.
//
// V8 tuning: the driver already turns incremental marking off. This
// module additionally turns the optimising compiler off. The build is
// short-lived and runs once per process, so the optimising compiler's
// own CPU costs more than its faster code saves; the baseline compiler
// (Sparkplug) runs the same code natively without that cost. The flag
// is set here, at import time, before any of this module's functions
// is compiled.

import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-opt');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const RESERVED = ['posts', 'tags', 'page'];

// ------------------------------------------------------------------ escaping

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;
const ESC_FIND = /[&<>"']/g;

/** `s` with & < > " and ' escaped, as one string. */
function escStr(s) {
  return ESC_TEST.test(s) ? s.replace(ESC_RE, (c) => ESC[c]) : s;
}

/**
 * The slice s[lo, hi) escaped, pushed onto `parts` in bulk: one regex
 * scan finds the next special character, and the plain run before it
 * is pushed whole, so text with no specials costs one scan and one
 * slice. (ESC_FIND's lastIndex is always set before each exec, so this
 * stays correct however it is called.)
 */
function pushEsc(parts, s, lo, hi) {
  if (lo >= hi) return;
  ESC_FIND.lastIndex = lo;
  let m = ESC_FIND.exec(s);
  if (m === null || m.index >= hi) {
    parts.push(s.slice(lo, hi));
    ESC_FIND.lastIndex = 0;
    return;
  }
  let i = lo;
  while (m !== null && m.index < hi) {
    const n = m.index;
    if (n > i) parts.push(s.slice(i, n));
    parts.push(ESC[s[n]]);
    i = n + 1;
    if (i >= hi) break;
    ESC_FIND.lastIndex = i;
    m = ESC_FIND.exec(s);
  }
  if (i < hi) parts.push(s.slice(i, hi));
  ESC_FIND.lastIndex = 0;
}

// ------------------------------------------------------------------ text rules

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/**
 * The slug of `text`, exactly as makefun-site's: NFKD, combining marks
 * dropped, A-Z lowered, each run of other characters one "-", none at
 * either end, cut to 64 characters (a "-" left at the cut dropped), and
 * "untitled" when nothing is left. The ASCII fast path below handles
 * the common case without ever normalising.
 */
function slugifyUnicode(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function slugifyRaw(text) {
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 127) return slugifyUnicode(text);
    let keep = '';
    if (code >= 65 && code <= 90) keep = String.fromCharCode(code + 32);
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = text[i];
    else {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += keep;
  }
  out = out.slice(0, SLUG_MAX);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

/** slugify, memoised per case (a pure function; titles and tag names repeat). */
function slugify(text, B) {
  let v = B.slugCache.get(text);
  if (v === undefined) {
    v = slugifyRaw(text);
    B.slugCache.set(text, v);
  }
  return v;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  let out;
  do {
    out = slug + '-' + n;
    n++;
  } while (taken.has(out));
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone, memoised per case. */
function longDate(date, B) {
  let v = B.dateCache.get(date);
  if (v === undefined) {
    v = Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
    B.dateCache.set(date, v);
  }
  return v;
}

/** Whether the UTF-16 code unit `code` is JavaScript \s whitespace. */
function isWS(code) {
  return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32 ||
    code === 160 || code === 5760 || (code >= 8192 && code <= 8202) || code === 8232 || code === 8233 ||
    code === 8239 || code === 8287 || code === 12288 || code === 65279;
}

const WORDS_RE = /\S+/g;

/** The words of one line: its runs of characters other than whitespace. */
function countWords(line) {
  let n = 0;
  WORDS_RE.lastIndex = 0;
  while (WORDS_RE.exec(line) !== null) n++;
  return n;
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

/** A line of only spaces and tabs (or empty). */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return s === 0 && e === line.length ? line : line.slice(s, e);
}

/** `s` with trailing spaces and tabs dropped. */
function stripTrailingWS(s) {
  let e = s.length;
  while (e > 0 && (s.charCodeAt(e - 1) === 32 || s.charCodeAt(e - 1) === 9)) e--;
  return e === s.length ? s : s.slice(0, e);
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function isKeyChar(code) {
  return (code >= 97 && code <= 122) || code === 95;
}

function isNameChar(code) {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 45;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    const parts = [];
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        parts.push(n);
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else parts.push(c);
    }
    return { value: parts.join('') };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function dateOf(raw) {
  let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
  if (ok) {
    for (let i = 0; i < 10; i++) {
      if (i === 4 || i === 7) continue;
      const c = raw.charCodeAt(i);
      if (c < 48 || c > 57) {
        ok = false;
        break;
      }
    }
  }
  const y = ok ? Number(raw.slice(0, 4)) : 0;
  const mo = ok ? Number(raw.slice(5, 7)) : 0;
  const d = ok ? Number(raw.slice(8, 10)) : 0;
  if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
    return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
  }
  return { value: raw };
}

function tagsOf(raw) {
  if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
  const inner = raw.slice(1, -1);
  if (inner.trim() === '') return { value: [] };
  const tags = inner.split(',').map((t) => t.trim());
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    for (let j = 0; j < t.length; j++) {
      const c = t.charCodeAt(j);
      if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
  }
  return { value: tags };
}

/** Whether `raw` is a template name: a-z, 0-9 and -, at least one character. */
function isName(raw) {
  if (raw.length === 0) return false;
  for (let i = 0; i < raw.length; i++) if (!isNameChar(raw.charCodeAt(i))) return false;
  return true;
}

/** Whether `raw` is a slug: a-z and 0-9, single - between, at most 64 characters. */
function isSlug(raw) {
  if (raw.length < 1 || raw.length > 64) return false;
  let prevDash = true;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 45) {
      if (prevDash) return false;
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
    else return false;
  }
  return !prevDash;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return s.error !== undefined ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date':
      return dateOf(raw);
    case 'tags':
      return tagsOf(raw);
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlug(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

/**
 * A source's front matter and body: { data, close } (close is the index
 * of the closing --- line in `lines`), or { error } with the first
 * reason it is refused.
 */
function parseFrontMatter(lines) {
  if (lines.length === 0 || lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
    let k = 0;
    while (k < line.length && isKeyChar(line.charCodeAt(k))) k++;
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: 'line ' + (i + 1) + ' is not "key: value"' };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = stripTrailingWS(line.slice(k + 2));
    else return { error: 'line ' + (i + 1) + ' is not "key: value"' };
    if (KEYS.indexOf(key) === -1) return { error: 'unknown key "' + key + '"' };
    if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (raw === '') return { error: 'key "' + key + '" has no value' };
    const v = valueOf(key, raw);
    if (v.error !== undefined) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, close };
}

// ------------------------------------------------------------------- markdown

const L_BLANK = 0;
const L_FENCE = 1;
const L_HEADING = 2;
const L_HR = 3;
const L_QUOTE = 4;
const L_BULLET = 5;
const L_ORDERED = 6;
const L_PARA = 7;

function isLangChar(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) ||
    code === 95 || code === 43 || code === 45;
}

function isDigit(code) {
  return code >= 48 && code <= 57;
}

/** One line's block kind, in the order the reference checks them. */
function classify(line) {
  const len = line.length;
  if (len === 0) return L_BLANK;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) {
    for (let i = 1; i < len; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) return L_PARA;
    }
    return L_BLANK;
  }
  if (c0 === 96 && len >= 3 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96) {
    let i = 3;
    while (i < len && isLangChar(line.charCodeAt(i))) i++;
    while (i < len && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
    return i === len ? L_FENCE : L_PARA;
  }
  if (c0 === 35) {
    let n = 0;
    while (n < len && n < 7 && line.charCodeAt(n) === 35) n++;
    if (n >= 1 && n <= 6 && n < len && (line.charCodeAt(n) === 32 || line.charCodeAt(n) === 9)) {
      let s = n;
      while (s < len && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
      let e = len;
      while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
      if (e > s) return L_HEADING;
    }
    return L_PARA;
  }
  if (len >= 3 && ((c0 === 45 && line.charCodeAt(1) === 45 && line.charCodeAt(2) === 45) ||
      (c0 === 42 && line.charCodeAt(1) === 42 && line.charCodeAt(2) === 42))) {
    let i = 3;
    while (i < len && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
    return i === len ? L_HR : L_PARA;
  }
  if (c0 === 62) return L_QUOTE;
  if ((c0 === 45 || c0 === 42) && len >= 2 && line.charCodeAt(1) === 32) return L_BULLET;
  if (isDigit(c0)) {
    let i = 0;
    while (i < len && i < 10 && isDigit(line.charCodeAt(i))) i++;
    if (i >= 1 && i <= 9 && i + 1 < len && line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32) return L_ORDERED;
    return L_PARA;
  }
  return L_PARA;
}

/** Whether `line` is a fence close: three backticks, spaces or tabs after. */
function isFenceClose(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let s = 0;
  while (s < line.length && line.charCodeAt(s) === 32) s++;
  if (s < 2 || s >= line.length) return false;
  return !isWS(line.charCodeAt(s));
}

// --------------------------------------------------------------------- inline

/** Whether the UTF-16 code unit `code` is one a backslash escapes. */
function isEscapable(code) {
  return code === 92 || code === 96 || code === 42 || code === 95 || code === 91 || code === 93 ||
    code === 40 || code === 41 || code === 35 || code === 43 || code === 45 || code === 46 ||
    code === 33 || code === 62;
}

const WS_RE = /\s/;

/**
 * Whether the character at `p` is escaped by a backslash, judging from
 * the scan that starts at `from`: a run of backslashes immediately
 * before `p` escapes it exactly when the run is odd, because the scan
 * consumes backslash pairs left to right and always lands on the run's
 * first backslash (the character before the run is not a backslash).
 */
function isEscapedAt(s, p, from) {
  let n = 0;
  for (let q = p - 1; q >= from && s.charCodeAt(q) === 92; q--) n++;
  return (n & 1) === 1;
}

/** The first `what` ("**" or "]") from `from` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, hi) {
  let p = s.indexOf(what, from);
  while (p !== -1 && p < hi) {
    if (!isEscapedAt(s, p, from)) return p;
    p = s.indexOf(what, p + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  let p = s.indexOf('*', from);
  while (p !== -1 && p < hi) {
    if (isEscapedAt(s, p, from)) {
      p = s.indexOf('*', p + 1);
      continue;
    }
    if (s.charCodeAt(p + 1) === 42) {
      p = s.indexOf('*', p + 2);
      continue;
    }
    return p;
  }
  return -1;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePathRaw(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** resolvePathRaw, memoised per case (a pure function; the same relative targets recur across sources). */
function resolvePath(dir, rel, cache) {
  const key = dir + '\n' + rel;
  let v = cache.get(key);
  if (v === undefined) {
    v = resolvePathRaw(dir, rel);
    cache.set(key, v);
  }
  return v;
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** A link target's href, resolving relative paths against the source's directory. */
function resolveLink(ctx, target) {
  if (SCHEME_RE.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(ctx.dir, rel, ctx.paths);
  if (path !== null) {
    const pg = ctx.bySource.get(path);
    if (pg !== undefined) return pg.url + frag;
    if (ctx.staticPaths.has(path)) return ctx.base + '/' + path + frag;
  }
  ctx.broken.add('broken-link ' + ctx.srcPath + ' -> ' + target);
  return target;
}

/** Every character the inline scan must stop at: an inline special (\ ` * [) or an HTML special (& < > " '). */
const ALL_RE = /[\\`*\[&<>"']/g;

/**
 * The range s[lo, hi) rendered inline into `parts`. One regex scan
 * finds the next character needing attention; the plain run before it
 * holds no special of either kind, so it is pushed whole with no
 * escaping at all. (ALL_RE's lastIndex is set before every exec, so
 * the recursion through nested strong, emphasis and link text stays
 * correct.) Recursion works on ranges of the same string, never on
 * slices, so nesting costs no copies.
 */
function renderInline(s, lo, hi, ctx, parts) {
  let i = lo;
  while (i < hi) {
    ALL_RE.lastIndex = i;
    const m = ALL_RE.exec(s);
    const n = m !== null && m.index < hi ? m.index : -1;
    if (n === -1) break;
    if (n > i) parts.push(s.slice(i, n));
    const c = s.charCodeAt(n);
    if (c === 38) {
      parts.push('&amp;');
      i = n + 1;
      continue;
    }
    if (c === 60) {
      parts.push('&lt;');
      i = n + 1;
      continue;
    }
    if (c === 62) {
      parts.push('&gt;');
      i = n + 1;
      continue;
    }
    if (c === 34) {
      parts.push('&quot;');
      i = n + 1;
      continue;
    }
    if (c === 39) {
      parts.push('&#39;');
      i = n + 1;
      continue;
    }
    if (c === 92) {
      if (n + 1 < hi && isEscapable(s.charCodeAt(n + 1))) {
        const e = s[n + 1];
        const ent = ESC[e];
        parts.push(ent !== undefined ? ent : e);
        i = n + 2;
      } else {
        parts.push('\\');
        i = n + 1;
      }
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', n + 1);
      if (j !== -1 && j < hi && j > n + 1) {
        parts.push('<code>');
        pushEsc(parts, s, n + 1, j);
        parts.push('</code>');
        i = j + 1;
      } else {
        parts.push('`');
        i = n + 1;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(n + 1) === 42) {
        const j = findUnescaped(s, '**', n + 2, hi);
        if (j !== -1 && j > n + 2) {
          parts.push('<strong>');
          renderInline(s, n + 2, j, ctx, parts);
          parts.push('</strong>');
          i = j + 2;
        } else {
          parts.push('**');
          i = n + 2;
        }
      } else {
        const j = findSingleStar(s, n + 1, hi);
        if (j !== -1 && j > n + 1) {
          parts.push('<em>');
          renderInline(s, n + 1, j, ctx, parts);
          parts.push('</em>');
          i = j + 1;
        } else {
          parts.push('*');
          i = n + 1;
        }
      }
      continue;
    }
    const k2 = findUnescaped(s, ']', n + 1, hi);
    let m2 = -1;
    if (k2 !== -1 && s.charCodeAt(k2 + 1) === 40) {
      m2 = s.indexOf(')', k2 + 2);
      if (m2 === -1 || m2 >= hi) m2 = -1;
    }
    if (m2 !== -1) {
      const target = s.slice(k2 + 2, m2);
      if (target !== '' && !WS_RE.test(target)) {
        parts.push('<a href="', escStr(resolveLink(ctx, target)), '">');
        renderInline(s, n + 1, k2, ctx, parts);
        parts.push('</a>');
        i = m2 + 1;
        continue;
      }
    }
    parts.push('[');
    i = n + 1;
  }
  if (i < hi) parts.push(s.slice(i, hi));
  ALL_RE.lastIndex = 0;
}

/** `s` rendered inline, as one string (for a paragraph, heading or excerpt). */
function inlineStr(s, ctx) {
  const parts = [];
  renderInline(s, 0, s.length, ctx, parts);
  return parts.join('');
}

// ---------------------------------------------------------------- block render

/**
 * Lines[start, end) rendered: its HTML (each block on its own lines, a
 * "\n" after the last), its table of contents and its excerpt (the
 * first paragraph's inline HTML, or ""). Blocks are rendered straight
 * into one parts array; each line is classified once, and a paragraph
 * keeps the next line's classification for the outer loop.
 */
function renderMarkdown(lines, start, end, ctx, B) {
  const parts = [];
  const toc = [];
  const ids = B.ids;
  ids.clear();
  let excerpt = null;
  let i = start;
  let cls = -1;
  while (i < end) {
    if (cls === -1) cls = classify(lines[i]);
    const line = lines[i];
    if (cls === L_BLANK) {
      i++;
      cls = -1;
      continue;
    }
    if (cls === L_FENCE) {
      let li = 3;
      while (li < line.length && isLangChar(line.charCodeAt(li))) li++;
      const lang = line.slice(3, li);
      parts.push('<pre><code');
      if (lang !== '') parts.push(' class="language-', escStr(lang), '"');
      parts.push('>');
      i++;
      while (i < end && !isFenceClose(lines[i])) {
        pushEsc(parts, lines[i], 0, lines[i].length);
        parts.push('\n');
        i++;
      }
      if (i < end) i++;
      parts.push('</code></pre>\n');
      cls = -1;
      continue;
    }
    if (cls === L_HEADING) {
      let n = 0;
      while (line.charCodeAt(n) === 35) n++;
      let s = n;
      while (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9) s++;
      let e = line.length;
      while (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9) e--;
      const text = line.slice(s, e);
      const id = uniqueSlug(slugify(text, B), B.ids);
      if (n === 2 || n === 3) {
        const html = inlineStr(text, ctx);
        parts.push('<h', String(n), ' id="', id, '">', html, '</h', String(n), '>\n');
        toc.push({ level: n, id, html });
      } else {
        parts.push('<h', String(n), ' id="', id, '">');
        renderInline(text, 0, text.length, ctx, parts);
        parts.push('</h', String(n), '>\n');
      }
      i++;
      cls = -1;
      continue;
    }
    if (cls === L_HR) {
      parts.push('<hr>\n');
      i++;
      cls = -1;
      continue;
    }
    if (cls === L_QUOTE) {
      const qlines = [];
      while (i < end && lines[i].charCodeAt(0) === 62) {
        let l = lines[i];
        l = l.length > 1 && l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        l = trimLine(l);
        if (l !== '') qlines.push(l);
        i++;
      }
      if (qlines.length === 0) parts.push('<blockquote>\n</blockquote>\n');
      else {
        parts.push('<blockquote>\n<p>');
        const q = qlines.join('\n');
        renderInline(q, 0, q.length, ctx, parts);
        parts.push('</p>\n</blockquote>\n');
      }
      cls = -1;
      continue;
    }
    if (cls === L_BULLET || cls === L_ORDERED) {
      const ordered = cls === L_ORDERED;
      let startNo = 1;
      if (ordered) {
        let d = 0;
        while (isDigit(line.charCodeAt(d))) d++;
        startNo = Number(line.slice(0, d));
      }
      const items = [];
      let cur = null;
      while (i < end) {
        const l = lines[i];
        const k = classify(l);
        if (ordered ? k === L_ORDERED : k === L_BULLET) {
          if (cur !== null) items.push(cur.join('\n'));
          if (ordered) {
            let d = 0;
            while (isDigit(l.charCodeAt(d))) d++;
            cur = [trimLine(l.slice(d + 2))];
          } else {
            cur = [trimLine(l.slice(2))];
          }
          i++;
        } else if (cur !== null && isContinued(l)) {
          cur.push(trimLine(l));
          i++;
        } else break;
      }
      if (cur !== null) items.push(cur.join('\n'));
      if (ordered && startNo !== 1) parts.push('<ol start="', String(startNo), '">\n');
      else parts.push(ordered ? '<ol>\n' : '<ul>\n');
      for (let t = 0; t < items.length; t++) {
        parts.push('<li>');
        renderInline(items[t], 0, items[t].length, ctx, parts);
        parts.push('</li>\n');
      }
      parts.push(ordered ? '</ol>\n' : '</ul>\n');
      cls = -1;
      continue;
    }
    const plines = [trimLine(line)];
    i++;
    cls = -1;
    while (i < end) {
      const k = classify(lines[i]);
      if (k === L_BLANK || k === L_FENCE || k === L_HEADING || k === L_HR) {
        cls = k;
        break;
      }
      plines.push(trimLine(lines[i]));
      i++;
    }
    const text = plines.join('\n');
    if (excerpt === null) {
      const html = inlineStr(text, ctx);
      excerpt = html;
      parts.push('<p>', html, '</p>\n');
    } else {
      parts.push('<p>');
      renderInline(text, 0, text.length, ctx, parts);
      parts.push('</p>\n');
    }
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------------ templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

/** Whether src[lo, hi) holds only spaces and tabs. */
function isOnlyWS(src, lo, hi) {
  for (let i = lo; i < hi; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isOnlyWS(src, lineStart, open) && isOnlyWS(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError('template "' + name + '": an else outside an if');
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.body;
}

/** Follow a name bound by an enclosing for to the root it derives from. */
function resolveRoot(name, bound) {
  let r = name;
  const seen = new Set();
  while (bound.has(r) && !seen.has(r)) {
    seen.add(r);
    r = bound.get(r);
  }
  return r;
}

/**
 * The root names a template's own nodes read: every var, raw, if and
 * for path's first segment, with names bound by its own fors mapped to
 * the root those fors read from. (Includes are added transitively by
 * finalizeTemplates.)
 */
function directRefs(nodes) {
  const refs = new Set();
  const walk = (ns, bound) => {
    for (const nd of ns) {
      if (nd.kind === 'var' || nd.kind === 'raw') refs.add(resolveRoot(nd.path[0], bound));
      else if (nd.kind === 'if') {
        refs.add(resolveRoot(nd.path[0], bound));
        walk(nd.then, bound);
        if (nd.else !== null) walk(nd.else, bound);
      } else if (nd.kind === 'for') {
        const root = resolveRoot(nd.path[0], bound);
        refs.add(root);
        const inner = new Map(bound);
        inner.set(nd.name, root);
        inner.set('loop', root);
        walk(nd.body, inner);
      }
    }
  };
  walk(nodes, new Map());
  return refs;
}

/** Every include name a node tree holds, in order. */
function collectIncludes(nodes, cb) {
  for (const nd of nodes) {
    if (nd.kind === 'include') cb(nd.name);
    else if (nd.kind === 'if') {
      collectIncludes(nd.then, cb);
      if (nd.else !== null) collectIncludes(nd.else, cb);
    } else if (nd.kind === 'for') collectIncludes(nd.body, cb);
  }
}

/**
 * Decide, per template, whether an include of it may be memoised:
 * kind 1 when its output depends only on the case-global values
 * (site, tags, recent); kind 2 when it depends on those plus exactly
 * one other root value, memoised per that value; kind 0 otherwise
 * (including any template that reads the caller's `loop`, whose object
 * is reused and mutated while a loop runs).
 */
function finalizeTemplates(templates) {
  const refsMap = new Map();
  for (const t of templates.values()) refsMap.set(t.name, directRefs(t.nodes));
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of templates.values()) {
      const refs = refsMap.get(t.name);
      const before = refs.size;
      collectIncludes(t.nodes, (inc) => {
        const r = refsMap.get(inc);
        if (r !== undefined) for (const x of r) refs.add(x);
      });
      if (refs.size !== before) changed = true;
    }
  }
  for (const t of templates.values()) {
    const refs = refsMap.get(t.name);
    if (refs.has('loop')) {
      t.cacheKind = 0;
      continue;
    }
    const varying = [];
    for (const r of refs) if (r !== 'site' && r !== 'tags' && r !== 'recent') varying.push(r);
    if (varying.length === 0) {
      t.cacheKind = 1;
      t.gcache = [];
    } else if (varying.length === 1) {
      t.cacheKind = 2;
      t.varying = varying[0];
      t.scacheObj = new WeakMap();
      t.scachePrim = new Map();
    } else t.cacheKind = 0;
  }
}

/** The value at `path` in the scope chain: its first name from the nearest frame holding it, then own properties. */
function lookup(frames, path) {
  const name = path[0];
  let v;
  let found = false;
  for (let f = frames.length - 1; f >= 0; f--) {
    const fr = frames[f];
    if (name in fr) {
      v = fr[name];
      found = true;
      break;
    }
  }
  if (!found) return undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += textOf(v[i]);
    }
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** One include, memoised when the template's cache kind allows it. */
function renderInclude(t, frames, ctx, depth, parts) {
  if (t.cacheKind === 1) {
    let s = t.gcache[depth];
    if (s === undefined) {
      const tmp = [];
      renderNodes(t.nodes, frames, ctx, depth, tmp);
      s = tmp.join('');
      t.gcache[depth] = s;
    }
    parts.push(s);
    return;
  }
  if (t.cacheKind === 2) {
    const val = lookup(frames, [t.varying]);
    let slot;
    if (val !== null && (typeof val === 'object' || typeof val === 'function')) {
      slot = t.scacheObj.get(val);
      if (slot === undefined) {
        slot = [];
        t.scacheObj.set(val, slot);
      }
    } else {
      slot = t.scachePrim.get(val);
      if (slot === undefined) {
        slot = [];
        t.scachePrim.set(val, slot);
      }
    }
    let s = slot[depth];
    if (s === undefined) {
      const tmp = [];
      renderNodes(t.nodes, frames, ctx, depth, tmp);
      s = tmp.join('');
      slot[depth] = s;
    }
    parts.push(s);
    return;
  }
  renderNodes(t.nodes, frames, ctx, depth, parts);
}

/**
 * `nodes` rendered into `parts`. A loop reuses one frame and one loop
 * object for all its elements (rendering is synchronous, so nothing
 * observes the mutation); `loop` is read fresh from that object.
 */
function renderNodes(nodes, frames, ctx, depth, parts) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        parts.push(n.text);
        break;
      case 'var':
        parts.push(escStr(textOf(lookup(frames, n.path))));
        break;
      case 'raw':
        parts.push(textOf(lookup(frames, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(frames, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, frames, ctx, depth, parts);
        break;
      }
      case 'for': {
        const xs = lookup(frames, n.path);
        if (!Array.isArray(xs)) break;
        const loop = { index: 0, first: false, last: false, length: xs.length };
        const frame = Object.create(null);
        frames.push(frame);
        for (let k = 0; k < xs.length; k++) {
          frame[n.name] = xs[k];
          // The loop object wins when the element is itself named "loop",
          // as in the reference's {[name]: x, loop: {...}} literal.
          frame.loop = loop;
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, frames, ctx, depth, parts);
        }
        frames.pop();
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderInclude(t, frames, ctx, depth + 1, parts);
        break;
      }
    }
  }
}

/** One template rendered with `vars` (plus site, tags, recent), or null when it is missing. */
function renderRoot(ctx, name, vars) {
  const t = ctx.templates.get(name);
  if (t === undefined) return null;
  const root = Object.create(null);
  root.site = ctx.site;
  root.tags = ctx.allTags;
  root.recent = ctx.recent;
  for (const k of Object.keys(vars)) root[k] = vars[k];
  const parts = [];
  renderNodes(t.nodes, [root], ctx, 0, parts);
  return parts.join('');
}

// ---------------------------------------------------------------------- build

/** A page's link record as templates read it. */
function linkOf(s, B) {
  if (s === null) return null;
  return { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date, B) };
}

/** A post's card, as lists show it. */
function cardOf(s, B) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date, B),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s, B) {
  const card = cardOf(s, B);
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null, B),
    older: linkOf(s.older ?? null, B),
    is_post: s.post,
  };
}

/** A tag as templates read it (its posts as cards). */
function tagOf(t, cards) {
  return { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const B = { slugCache: new Map(), dateCache: new Map(), ids: new Set() };

  // Templates, parsed in code-unit order of their name; one that does
  // not parse is reported and left out, as if it were not there.
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      templates.set(name, { name, nodes: parseTemplate(name, input.templates[name]), cacheKind: 0, varying: null, gcache: null, scacheObj: null, scachePrim: null });
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  finalizeTemplates(templates);

  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources, in code-unit order of their paths; a source that is not
  // .md is static. Lines are split once and shared by the front matter
  // and the Markdown renderer.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      // Line ends made "\n"; the replace is skipped when the content
      // holds no "\r" at all, so the common case copies nothing.
      const raw = f.content;
      const text = raw.indexOf('\r') === -1 ? raw : raw.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, lines: text.split('\n') });
    } else statics.push(f);
  }

  // Front matter, in order: refused, the generator's own directory, a
  // post with no date, a layout that is no template, a draft.
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.lines);
    if (fm.error !== undefined) {
      report.push('refused ' + s.path + ': ' + fm.error);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.close + 1;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own');
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push('draft ' + s.path);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, B), set);
    s.outDir = dir === '' ? s.slug : dir + '/' + s.slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const pathCache = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    let words = 0;
    for (let j = s.bodyStart; j < s.lines.length; j++) words += countWords(s.lines[j]);
    s.words = words;
    const ctx = { dir: dirOf(s.path), bySource, staticPaths, base, broken, srcPath: s.path, paths: pathCache };
    const md = renderMarkdown(s.lines, s.bodyStart, s.lines.length, ctx, B);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, and equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by their slug, each named as first met walking the
  // posts in collection order, ordered by count then slug.
  const bySlug = new Map();
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    const seen = new Set();
    const names2 = p.data.tags ?? [];
    for (let j = 0; j < names2.length; j++) {
      const name = names2[j];
      const slug = slugify(name, B);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    s.tagRefs = [];
    const seen = new Set();
    const names2 = s.data.tags ?? [];
    for (let j = 0; j < names2.length; j++) {
      const name = names2[j];
      const slug = slugify(name, B);
      if (seen.has(slug)) continue;
      seen.add(slug);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts: every page through its layout, the index pages and the tag pages.
  const cards = new Map();
  for (let i = 0; i < posts.length; i++) cards.set(posts[i], cardOf(posts[i], B));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, site, allTags, recent };
  const output = {};
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    output[s.outDir + '/index.html'] = renderRoot(ctx, s.layout, { page: pageOf(s, B) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = renderRoot(ctx, 'index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const html = renderRoot(ctx, 'tag', { tag: tagOf(t, cards) });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = renderRoot(ctx, 'tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did
  // not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (let i = 0; i < kept.length; i++) if (!kept[i].post) pageCount++;
  lines.push('built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
