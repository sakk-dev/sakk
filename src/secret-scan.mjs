// SPDX-License-Identifier: AGPL-3.0-only
//
// Secret scanner (blueprint P1: "密钥/PII 出站扫描"). Rules that are the
// whole point:
//
// 1. ONE exemption, and it is a declared fiction: a SECRET (the part of a
//    match that carries the credential) is exempt only if it contains
//    TEST_ONLY_FAKE_SECRET_DO_NOT_USE. No localhost pass, never a list of
//    real fragments — the predecessor leaked through exactly such a list.
// 2. Output never contains a secret: rule, path, line and a keyed 12-hex
//    fingerprint. The key is random per process (set SAKK_SCAN_KEY to make
//    fingerprints comparable across runs — and keep that key private), so a
//    public CI log cannot be dictionary-reversed. A path that itself
//    contains a secret is printed redacted and counted as a finding.
// 3. A scan that could not look everywhere it was told to does not report
//    "clean": missing or unreadable inputs are errors, skips are counted.
// 4. Every pattern is length-bounded: a hostile line costs linear time.

import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const FICTIONAL_EXEMPTION_TOKEN = 'TEST_ONLY_FAKE_SECRET_DO_NOT_USE';
/** The entire exemption list. A test pins it to exactly this one entry. */
export const EXEMPTIONS = Object.freeze([FICTIONAL_EXEMPTION_TOKEN]);

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
    re: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"'@/:]{1,256}:([^\s"'@]{1,256})@/gi,
    group: 1,
  },
  {
    name: 'url_encoded_password',
    re: /:\/\/[^\s"'@/:]{1,256}:((?=[^\s"'@]{0,256}%[0-9a-fA-F]{2})[^\s"'@]{1,256})@/g,
    group: 1,
  },
  { name: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'generic_api_key', re: /\b(?:sk|rk)[-_](?:live_|test_)?[A-Za-z0-9_-]{20,200}/g },
  {
    name: 'github_token',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})/g,
  },
  { name: 'private_key_block', re: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g },
  { name: 'bearer_token', re: /\bBearer\s{1,5}[A-Za-z0-9._-]{25,500}/g },
  {
    name: 'password_assignment',
    re: /(?:password|passwd|pwd)["']?\s{0,10}[:=]\s{0,10}["']([^"'\n]{8,256})["']/gi,
    group: 1,
  },
]);

const KEY = process.env.SAKK_SCAN_KEY ? Buffer.from(process.env.SAKK_SCAN_KEY) : randomBytes(32);
const fingerprint = (value) => createHmac('sha256', KEY).update(value).digest('hex').slice(0, 12);

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
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      const secret = rule.group ? m[rule.group] : m[0];
      if (EXEMPTIONS.some((t) => secret.includes(t))) {
        exempted += 1; // counted, never silent
        continue;
      }
      findings.push({
        rule: rule.name,
        path,
        line: lineOf(m.index),
        fingerprint: fingerprint(secret),
      });
    }
  }
  return { findings, exempted };
}

/** Paths are output too: a path containing a secret is redacted AND reported. */
function displayPath(p, findings) {
  const hits = scanText(p, '(path)').findings;
  if (hits.length === 0) return p;
  const shown = `[redacted path ${hits[0].fingerprint}]`;
  for (const h of hits) findings.push({ ...h, path: shown, line: 0 });
  return shown;
}

const SKIP_DIR = new Set(['node_modules', '.git', '.next', 'dist']);
const SKIP_EXT = /\.(png|jpe?g|gif|zip|gz|tgz|woff2?|ico|mp4|bundle)$/i;

/** Decode for scanning; UTF-16 (BOM) is text, a NUL in UTF-8 is binary. */
function asText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
    return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buf.subarray(0, 8000).includes(0)) return null;
  return buf.toString('utf8');
}

/**
 * Scan files/directories. Explicit roots must exist (SCAN_PATH_MISSING)
 * and are scanned even if their name is in the skip list; only DISCOVERED
 * children are skipped. Symlinks are never followed. Unreadable entries are
 * collected — the caller must not call the result clean.
 */
export function scanPaths(paths) {
  const findings = [];
  const unreadable = [];
  const skipped = { symlink: 0, binary: 0, ignoredDir: 0, ignoredExt: 0 };
  let exempted = 0;
  let scanned = 0;
  const present = (p) => {
    try {
      lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };
  for (const p of paths)
    if (!present(p))
      throw new ScanError(
        'SCAN_PATH_MISSING',
        `${displayPath(p, [])} does not exist — a scan of nothing is not a pass`,
      );
  const walk = (p, explicit) => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      unreadable.push(displayPath(p, findings));
      return;
    }
    if (st.isSymbolicLink()) {
      skipped.symlink += 1;
      return;
    }
    if (st.isDirectory()) {
      if (!explicit && SKIP_DIR.has(p.split('/').pop())) {
        skipped.ignoredDir += 1;
        return;
      }
      let names;
      try {
        names = readdirSync(p);
      } catch {
        unreadable.push(displayPath(p, findings));
        return;
      }
      for (const name of names) walk(join(p, name), false);
      return;
    }
    if (!st.isFile()) return;
    const shown = displayPath(p, findings);
    if (!explicit && SKIP_EXT.test(p)) {
      skipped.ignoredExt += 1;
      return;
    }
    let buf;
    try {
      buf = readFileSync(p);
    } catch {
      unreadable.push(shown);
      return;
    }
    const text = asText(buf);
    if (text === null) {
      skipped.binary += 1;
      return;
    }
    scanned += 1;
    const r = scanText(text, shown);
    findings.push(...r.findings);
    exempted += r.exempted;
  };
  for (const p of paths) walk(p, true);
  return { findings, exempted, scanned, skipped, unreadable };
}

/**
 * Scan exactly what `git commit` is about to record: the STAGED blob of
 * every added/copied/modified/renamed/TYPE-CHANGED path, read by blob id
 * (no `:path` parsing, so names like `0:foo` cannot be misread). Gitlinks
 * (submodules) carry no content here and are skipped, counted.
 */
export function scanStaged(cwd = process.cwd()) {
  const git = (args, opts = {}) =>
    execFileSync('git', args, {
      cwd,
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
  try {
    git(['rev-parse', '--git-dir']);
  } catch {
    throw new ScanError('SCAN_NOT_A_REPO', '--staged must run inside a git repository');
  }
  const names = git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  const index = new Map();
  for (const rec of git(['ls-files', '-s', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)) {
    const tab = rec.indexOf('\t');
    const [mode, sha] = rec.slice(0, tab).split(' ');
    index.set(rec.slice(tab + 1), { mode, sha });
  }
  const findings = [];
  const skipped = { gitlink: 0, binary: 0, symlink: 0 };
  let exempted = 0;
  let scanned = 0;
  for (const name of names) {
    const shown = displayPath(name, findings);
    const e = index.get(name);
    if (!e) continue;
    if (e.mode === '160000') {
      skipped.gitlink += 1;
      continue;
    }
    if (e.mode === '120000') {
      skipped.symlink += 1; // the link target string, not file content
      continue;
    }
    const text = asText(git(['cat-file', 'blob', e.sha]));
    if (text === null) {
      skipped.binary += 1;
      continue;
    }
    scanned += 1;
    const r = scanText(text, shown);
    findings.push(...r.findings);
    exempted += r.exempted;
  }
  return { findings, exempted, scanned, skipped, unreadable: [] };
}
