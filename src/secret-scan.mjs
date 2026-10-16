// SPDX-License-Identifier: AGPL-3.0-only
//
// Secret scanner (blueprint P1: "密钥/PII 出站扫描"). Two rules that are
// the whole point:
//
// 1. ONE exemption, and it is a declared fiction: a value is exempt only if
//    it contains TEST_ONLY_FAKE_SECRET_DO_NOT_USE. No localhost exception,
//    no "looks like a test value" exception, and never a list of real
//    fragments — the predecessor system leaked exactly through an
//    exemption list that contained real password fragments.
// 2. A finding NEVER contains the matched text: rule, path, line and a
//    12-hex sha256 fingerprint only. Enough to tell "same value in two
//    places", impossible to reverse.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const FICTIONAL_EXEMPTION_TOKEN = 'TEST_ONLY_FAKE_SECRET_DO_NOT_USE';
/** The entire exemption list. A test pins it to exactly this one entry. */
export const EXEMPTIONS = Object.freeze([FICTIONAL_EXEMPTION_TOKEN]);

export const RULES = Object.freeze([
  {
    name: 'dsn_with_password',
    re: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"'@/]+:[^\s"'@]+@/gi,
  },
  { name: 'url_encoded_password', re: /:\/\/[^\s"'@/]+:[^\s"'@]*%[0-9a-fA-F]{2}[^\s"'@]*@/g },
  { name: 'aws_access_key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'generic_api_key', re: /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}/g },
  { name: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: 'private_key_block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9._-]{25,}/g },
  {
    name: 'password_assignment',
    re: /(?:password|passwd|pwd)["']?\s*[:=]\s*["'][^"']{8,}["']/gi,
  },
]);

const fingerprint = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12);

/** Scan one text. Returns { findings: [{rule,path,line,fingerprint}], exempted }. */
export function scanText(text, path = '(inline)') {
  const findings = [];
  let exempted = 0;
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags); // never share lastIndex state
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = m[0];
      if (EXEMPTIONS.some((t) => value.includes(t))) {
        exempted += 1; // counted, never silent
        continue;
      }
      const line = text.slice(0, m.index).split('\n').length;
      findings.push({ rule: rule.name, path, line, fingerprint: fingerprint(value) });
    }
  }
  return { findings, exempted };
}

const SKIP_DIR = new Set(['node_modules', '.git', '.next', 'dist']);
const SKIP_EXT = /\.(png|jpe?g|gif|pdf|zip|gz|tgz|woff2?|ico|mp4|bundle)$/i;
const looksBinary = (buf) => buf.subarray(0, 8000).includes(0);

/** Recursively scan files/directories. Symlinks are skipped (no loops, no
 * escaping the tree); binaries are skipped by extension and NUL sniffing. */
export function scanPaths(paths) {
  const findings = [];
  let exempted = 0;
  let scanned = 0;
  const walk = (p) => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      if (SKIP_DIR.has(p.split('/').pop())) return;
      for (const name of readdirSync(p)) walk(join(p, name));
      return;
    }
    if (!st.isFile() || SKIP_EXT.test(p)) return;
    let buf;
    try {
      buf = readFileSync(p);
    } catch {
      return;
    }
    if (looksBinary(buf)) return;
    scanned += 1;
    const r = scanText(buf.toString('utf8'), p);
    findings.push(...r.findings);
    exempted += r.exempted;
  };
  for (const p of paths) walk(p);
  return { findings, exempted, scanned };
}

/** Scan exactly what `git commit` is about to record: the STAGED blob of
 * every added/copied/modified/renamed path (not the working-tree file,
 * which may differ). Run inside the repository. */
export function scanStaged(cwd = process.cwd()) {
  const names = execFileSync(
    'git',
    ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'],
    {
      cwd,
      encoding: 'utf8',
    },
  )
    .split('\0')
    .filter(Boolean);
  const findings = [];
  let exempted = 0;
  let scanned = 0;
  for (const name of names) {
    if (SKIP_EXT.test(name)) continue;
    const buf = execFileSync('git', ['show', `:${name}`], { cwd, maxBuffer: 1 << 28 });
    if (looksBinary(buf)) continue;
    scanned += 1;
    const r = scanText(buf.toString('utf8'), name);
    findings.push(...r.findings);
    exempted += r.exempted;
  }
  return { findings, exempted, scanned };
}
