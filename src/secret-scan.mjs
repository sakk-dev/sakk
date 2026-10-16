// SPDX-License-Identifier: AGPL-3.0-only
//
// Secret scanner (blueprint P1: "密钥/PII 出站扫描"). Rules that are the
// whole point:
//
// 1. ONE exemption, and it is a declared fiction: a SECRET (the part of a
//    match that carries the credential) is exempt only if it contains
//    TEST_ONLY_FAKE_SECRET_DO_NOT_USE and nothing secret-shaped remains once
//    the token is removed. No localhost pass, never a list of real
//    fragments — the predecessor leaked through exactly such a list.
// 2. Output never contains a secret: rule, path, line and a keyed 12-hex
//    fingerprint. The key is random per process (set SAKK_SCAN_KEY to make
//    fingerprints comparable across runs — and keep that key private), so a
//    public CI log cannot be dictionary-reversed. A name that itself
//    contains a secret is printed redacted and counted as a finding; control
//    characters in names are escaped so a file name cannot forge output.
// 3. A scan that could not look everywhere it was told to does not report
//    "clean": missing, unreadable, special or oversize inputs are errors,
//    skips are counted.
// 4. Every pattern is length-bounded: a hostile line costs linear time.

import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export const FICTIONAL_EXEMPTION_TOKEN = 'TEST_ONLY_FAKE_SECRET_DO_NOT_USE';
/** The entire exemption list. A test pins it to exactly this one entry. */
export const EXEMPTIONS = Object.freeze([FICTIONAL_EXEMPTION_TOKEN]);
/** Larger blobs/files are reported unreadable (exit 2), never silently passed. */
export const MAX_SCAN_BYTES = 256 * 1024 * 1024;

export class ScanError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

// `group` names the capture group that holds the secret itself; the
// exemption is judged on that part only (a token in the USERNAME must not
// exempt a real password).
export const RULES = Object.freeze([
  {
    name: 'dsn_with_password',
    re: /(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver):\/\/[^\s"'@/:]{0,256}:([^\s"'@]{1,256})@/gi,
    group: 1,
  },
  {
    name: 'url_encoded_password',
    re: /:\/\/[^\s"'@/:]{0,256}:((?=[^\s"'@]{0,256}%[0-9a-fA-F]{2})[^\s"'@]{1,256})@/g,
    group: 1,
  },
  { name: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    // `sk-…` (OpenAI/Anthropic style) or Stripe-style `sk_live_`/`rk_test_`;
    // a digit is required so identifiers like sk_set_flags never match.
    // Stripe-style `sk_live_`/`rk_test_` prefixes are strong enough alone;
    // a bare `sk-`/`sk_` needs a digit or 40+ chars, so identifiers like
    // sk_set_memalloc_and_flags never match.
    name: 'generic_api_key',
    re: /\b(?:[sr]k_(?:live|test)_[A-Za-z0-9]{20,200}|sk-[A-Za-z0-9_-]{40,200}|(?:sk|rk)[-_](?=[A-Za-z0-9_-]{0,200}\d)[A-Za-z0-9_-]{20,200})/g,
  },
  {
    name: 'github_token',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})/g,
  },
  { name: 'private_key_block', re: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g },
  { name: 'bearer_token', re: /\bBearer\s{1,5}[A-Za-z0-9._-]{25,500}/g },
  {
    name: 'password_assignment',
    re: /(?:password|passwd|pwd)["']?\s{0,40}[:=]\s{0,40}["']([^"'\n]{8,256})["']/gi,
    group: 1,
  },
]);

const KEY = process.env.SAKK_SCAN_KEY ? Buffer.from(process.env.SAKK_SCAN_KEY) : randomBytes(32);
const fingerprint = (value) => createHmac('sha256', KEY).update(value).digest('hex').slice(0, 12);

// A reference to a secret is not a secret: `${REDIS_PASSWORD}`, `$PW`,
// `%(pw)s`, `{{ pw }}` as the whole secret part of a URL or assignment.
const PLACEHOLDER =
  /^(?:\$\{[^}\s]{1,200}\}|\$[A-Za-z_][A-Za-z0-9_]{0,100}|%\([A-Za-z_][A-Za-z0-9_]{0,100}\)s|\{\{[^}]{1,200}\}\})$/;

function rawFindings(text) {
  const out = [];
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      const secret = rule.group ? m[rule.group] : m[0];
      if (rule.group && PLACEHOLDER.test(secret)) continue;
      out.push({ rule, index: m.index, end: m.index + m[0].length, secret });
    }
  }
  return out;
}

/** The text with every fiction token blanked (same length, so indices hold). */
const blankTokens = (text) =>
  EXEMPTIONS.reduce((t, tok) => t.split(tok).join(' '.repeat(tok.length)), text);

/** Exempt only a declared fiction with nothing secret-shaped left beside the token. */
function isExempt(secret) {
  if (!EXEMPTIONS.some((t) => secret.includes(t))) return false;
  let rest = secret;
  for (const t of EXEMPTIONS) rest = rest.split(t).join(' ');
  return rawFindings(rest).length === 0;
}

/** Scan one text. Returns { findings: [{rule,path,line,fingerprint}], exempted }. */
export function scanText(text, path = '(inline)') {
  const findings = [];
  let exempted = 0;
  let newlines = null; // computed once, on the first hit
  const lineOf = (idx) => {
    if (newlines === null) {
      newlines = [];
      for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) newlines.push(i);
    }
    let lo = 0;
    let hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (newlines[mid] < idx) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
  const spans = [];
  const add = (h) =>
    findings.push({
      rule: h.rule.name,
      path,
      line: lineOf(h.index),
      fingerprint: fingerprint(h.secret),
    });
  for (const h of rawFindings(text)) {
    if (isExempt(h.secret)) {
      exempted += 1; // counted, never silent
      continue;
    }
    spans.push([h.index, h.end]);
    add(h);
  }
  // A real key glued to a fiction token (TOKENsk_live_…) hides from `\b`,
  // and a greedy exempt match can swallow a real one (F-63); with the tokens
  // blanked both stand alone. Only an exempt match's span is open to the
  // second pass — a reported finding is never counted twice.
  if (EXEMPTIONS.some((t) => text.includes(t)))
    for (const h of rawFindings(blankTokens(text)))
      if (!spans.some(([a, b]) => h.index < b && h.end > a)) add(h);
  return { findings, exempted };
}

/** Names are output too: escape control characters, redact anything secret-shaped. */
export function display(p) {
  const hits = rawFindings(p).filter((h) => !isExempt(h.secret));
  if (hits.length > 0) return `[redacted path ${fingerprint(hits[0].secret)}]`;
  // C0, DEL, C1 and the Unicode line separators never reach a terminal raw
  // eslint-disable-next-line no-control-regex
  return p.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, (c) => {
    const n = c.charCodeAt(0);
    return n > 0xff
      ? `\\u${n.toString(16).padStart(4, '0')}`
      : `\\x${n.toString(16).padStart(2, '0')}`;
  });
}

/** A secret in a name is a finding — counted once, at the entry that carries it. */
function nameFindings(name, shown, findings) {
  for (const h of rawFindings(name))
    if (!isExempt(h.secret))
      findings.push({
        rule: h.rule.name,
        path: shown,
        line: 0,
        fingerprint: fingerprint(h.secret),
      });
}

const SKIP_DIR = new Set(['node_modules', '.git', '.next', 'dist']);
const SKIP_EXT = /\.(png|jpe?g|gif|zip|gz|tgz|woff2?|ico|mp4|bundle)$/i;

function utf32(buf, le) {
  let s = '';
  for (let i = 0; i + 3 < buf.length; i += 4) {
    const cp = le ? buf.readUInt32LE(i) : buf.readUInt32BE(i);
    if (cp > 0x10ffff) return null;
    s += String.fromCodePoint(cp);
  }
  return s;
}

/** Decode for scanning: UTF-32/UTF-16 by BOM are text; a NUL in UTF-8 is binary. */
function asText(buf) {
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0 && buf[3] === 0)
    return utf32(buf.subarray(4), true);
  if (buf.length >= 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 0xfe && buf[3] === 0xff)
    return utf32(buf.subarray(4), false);
  const even = (b) => b.subarray(0, b.length - (b.length % 2));
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
    return even(buf.subarray(2)).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(even(buf.subarray(2)));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buf.subarray(0, 8000).includes(0)) return null;
  return buf.toString('utf8');
}

/**
 * Scan files/directories. Explicit roots must exist (SCAN_PATH_MISSING),
 * are followed if they are links, and are scanned even if their name is in
 * the skip list; a root that is not a file or directory (fifo, device) is
 * unreadable. Only DISCOVERED children are skipped; links among them are
 * never followed. Unreadable entries are collected — the caller must not
 * call the result clean.
 */
export function scanPaths(paths) {
  const findings = [];
  const unreadable = [];
  const skipped = { symlink: 0, binary: 0, ignoredDir: 0, ignoredExt: 0, special: 0 };
  let exempted = 0;
  let scanned = 0;
  for (const p of paths) {
    try {
      lstatSync(p);
    } catch {
      throw new ScanError(
        'SCAN_PATH_MISSING',
        `${display(p)} does not exist — a scan of nothing is not a pass`,
      );
    }
  }
  const scanFile = (p, shown, size) => {
    if (size > MAX_SCAN_BYTES) {
      unreadable.push(`${shown} (larger than ${MAX_SCAN_BYTES} bytes)`);
      return;
    }
    let text;
    try {
      text = asText(readFileSync(p));
    } catch {
      unreadable.push(shown);
      return;
    }
    if (text === null) {
      skipped.binary += 1;
      return;
    }
    scanned += 1;
    const r = scanText(text, shown);
    findings.push(...r.findings);
    exempted += r.exempted;
  };
  const walk = (p, explicit) => {
    const shown = display(p);
    nameFindings(explicit ? p : basename(p), shown, findings);
    let st;
    try {
      st = explicit ? statSync(p) : lstatSync(p);
    } catch {
      unreadable.push(shown);
      return;
    }
    if (st.isSymbolicLink()) {
      skipped.symlink += 1;
      return;
    }
    if (st.isDirectory()) {
      if (!explicit && SKIP_DIR.has(basename(p))) {
        skipped.ignoredDir += 1;
        return;
      }
      let names;
      try {
        names = readdirSync(p);
      } catch {
        unreadable.push(shown);
        return;
      }
      for (const name of names) walk(join(p, name), false);
      return;
    }
    if (!st.isFile()) {
      if (explicit) unreadable.push(`${shown} (not a regular file)`);
      else skipped.special += 1;
      return;
    }
    if (!explicit && SKIP_EXT.test(p)) {
      skipped.ignoredExt += 1;
      return;
    }
    scanFile(p, shown, st.size);
  };
  for (const p of paths) walk(p, true);
  return { findings, exempted, scanned, skipped, unreadable };
}

/**
 * Scan exactly what `git commit` is about to record. The blob id and mode of
 * every added/modified/type-changed path come from ONE `git diff --cached
 * --raw -z` record each — no join on decoded names (two names that decode
 * alike, or cwd-relative vs root-relative paths, cannot hide a blob).
 * Gitlinks carry no content here and are skipped, counted; a staged
 * symlink's target string is committed content and is scanned.
 */
export function scanStaged(cwd = process.cwd()) {
  const git = (args, opts = {}) => {
    try {
      return execFileSync('git', args, {
        cwd,
        maxBuffer: Number.POSITIVE_INFINITY,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...opts,
      });
    } catch (e) {
      if (e.code === 'ENOENT') throw new ScanError('SCAN_GIT_MISSING', 'git is not on PATH');
      throw e;
    }
  };
  try {
    git(['rev-parse', '--git-dir']);
  } catch (e) {
    if (e instanceof ScanError) throw e;
    throw new ScanError('SCAN_NOT_A_REPO', '--staged must run inside a git repository');
  }
  const raw = git([
    'diff',
    '--cached',
    '--raw',
    '-z',
    '--no-relative', // diff.relative=true would hide files outside the cwd
    '--no-renames',
    '--no-abbrev',
    '--diff-filter=AMT',
  ]);
  const tokens = [];
  for (let start = 0, i = raw.indexOf(0); i !== -1; start = i + 1, i = raw.indexOf(0, start))
    tokens.push(raw.subarray(start, i));
  const records = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const m = tokens[i]
      .toString('latin1')
      .match(/^:\d{6} (\d{6}) [0-9a-f]{40,64} ([0-9a-f]{40,64}) ([AMT])$/);
    if (!m || tokens[i + 1] === undefined)
      throw new ScanError('SCAN_FAILED', 'unexpected `git diff --raw` output — refusing to guess');
    records.push({ mode: m[1], sha: m[2], name: tokens[i + 1].toString('utf8') });
  }
  const findings = [];
  const unreadable = [];
  const skipped = { gitlink: 0, binary: 0 };
  let exempted = 0;
  let scanned = 0;
  const todo = [];
  for (const r of records) {
    const shown = display(r.name);
    nameFindings(r.name, shown, findings);
    if (r.mode === '160000') {
      skipped.gitlink += 1;
      continue;
    }
    todo.push({ ...r, shown });
  }
  if (todo.length === 0) return { findings, exempted, scanned, skipped, unreadable };
  const sizes = git(['cat-file', '--batch-check=%(objectsize)'], {
    input: `${todo.map((t) => t.sha).join('\n')}\n`,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .map(Number);
  if (sizes.length !== todo.length)
    throw new ScanError('SCAN_FAILED', 'git cat-file returned a different number of objects');
  let batch = [];
  let bytes = 0;
  const flush = () => {
    if (batch.length === 0) return;
    const out = git(['cat-file', '--batch'], {
      input: `${batch.map((t) => t.sha).join('\n')}\n`,
    });
    let off = 0;
    for (const t of batch) {
      const nl = out.indexOf(10, off);
      const header = out.subarray(off, nl).toString('latin1').split(' ');
      if (header[0] !== t.sha || header[1] !== 'blob')
        throw new ScanError('SCAN_FAILED', `git cat-file did not return blob ${t.sha}`);
      const size = Number(header[2]);
      const text = asText(out.subarray(nl + 1, nl + 1 + size));
      off = nl + 1 + size + 1;
      if (text === null) {
        skipped.binary += 1;
        continue;
      }
      scanned += 1;
      const r = scanText(text, t.shown);
      findings.push(...r.findings);
      exempted += r.exempted;
    }
    batch = [];
    bytes = 0;
  };
  todo.forEach((t, i) => {
    if (!(sizes[i] >= 0)) {
      unreadable.push(`${t.shown} (object missing from the repository)`);
      return;
    }
    if (sizes[i] > MAX_SCAN_BYTES) {
      unreadable.push(`${t.shown} (larger than ${MAX_SCAN_BYTES} bytes)`);
      return;
    }
    if (bytes + sizes[i] > 64 * 1024 * 1024) flush();
    batch.push(t);
    bytes += sizes[i];
  });
  flush();
  return { findings, exempted, scanned, skipped, unreadable };
}
