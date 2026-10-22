// SPDX-License-Identifier: AGPL-3.0-only
//
// Port gitleaks' rule set (config/gitleaks.toml, MIT, pinned below) to JS
// regexes Node runs, writing src/secret-rules.generated.mjs. It refuses any
// construct it does not know, so it never guesses; a test re-runs it and
// requires byte-identical output. (specs/secret-guard "Translating the rules".)
//
// gitleaks is MIT licensed, (c) Zachary Rice. Source:
//   https://github.com/gitleaks/gitleaks  tag v8.21.2
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PINNED = { tag: 'v8.21.2', commit: 'a9e1950fe247fbb08817393121691474c55a6cfa' };
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
export const TOML_PATH = join(ROOT, 'config', 'gitleaks.toml');
export const OUT_PATH = join(ROOT, 'src', 'secret-rules.generated.mjs');

export class PortError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PortError';
  }
}

/**
 * Case-fold a regex segment so letters match either case without the i flag
 * (used for (?i:…) scopes and for the remainder after a mid-pattern (?i), where
 * a leading literal must stay case-sensitive). Escapes (\n, \w, \x60) and
 * non-letters are untouched. Throws on a construct it cannot fold safely.
 */
export function caseFold(seg) {
  let out = '';
  for (let i = 0; i < seg.length; i += 1) {
    const c = seg[i];
    if (c === '\\') {
      out += c + (seg[i + 1] ?? '');
      i += 1;
    } else if (c === '[') {
      // copy the class, adding the swapped case of any letter or letter-range
      let j = i + 1;
      let body = '';
      if (seg[j] === '^') {
        body += '^';
        j += 1;
      }
      while (j < seg.length && seg[j] !== ']') {
        if (seg[j] === '\\') {
          body += seg[j] + (seg[j + 1] ?? '');
          j += 2;
          continue;
        }
        // a letter range X-Y
        if (/[a-zA-Z]/.test(seg[j]) && seg[j + 1] === '-' && /[a-zA-Z]/.test(seg[j + 2])) {
          const lo = seg[j];
          const hi = seg[j + 2];
          body += `${lo}-${hi}`;
          if (/[a-z]/.test(lo) && /[a-z]/.test(hi))
            body += `${lo.toUpperCase()}-${hi.toUpperCase()}`;
          else if (/[A-Z]/.test(lo) && /[A-Z]/.test(hi))
            body += `${lo.toLowerCase()}-${hi.toLowerCase()}`;
          j += 3;
          continue;
        }
        if (/[a-zA-Z]/.test(seg[j])) {
          body +=
            seg[j] === seg[j].toLowerCase()
              ? seg[j] + seg[j].toUpperCase()
              : seg[j] + seg[j].toLowerCase();
          j += 1;
          continue;
        }
        body += seg[j];
        j += 1;
      }
      if (seg[j] !== ']') throw new PortError('unterminated character class while case-folding');
      out += `[${body}]`;
      i = j;
    } else if (/[a-zA-Z]/.test(c)) {
      out += `[${c}${c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()}]`;
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * Translate one Go (RE2) regex to a Node RegExp {source, flags}. Handles a
 * leading (?i) → i flag; a mid (?i) → case-fold the remainder; (?i:…) scopes;
 * (?P<name>) → (?<name>); \z → $. Refuses any other inline group flag.
 */
export function translate(re) {
  let flags = '';
  let src = re;
  // leading (?i): whole pattern case-insensitive → the i flag
  if (src.startsWith('(?i)')) {
    flags = 'i';
    src = src.slice(4);
  }
  // (?P<name>…) → (?<name>…)
  src = src.replace(/\(\?P</g, '(?<');
  // \z (end of text) → $ (no m flag is ever set, so $ is end of input)
  src = src.replace(/\\z/g, '$');
  // RE2 is linear; JS backtracks. gitleaks' "span up to N chars including
  // newlines" idiom (?:.|\s){0,N} is a two-way alternation that matches every
  // char via . OR \s, which blows up exponentially in JS. It is exactly the
  // any-char class, so rewrite it to [\s\S] (one class, linear in JS too).
  src = src.replace(/\(\?:(?:\.\|\\s|\\s\|\.|\.\|\\n|\\n\|\.)\)/g, '[\\s\\S]');
  // (?i:…) scoped case-insensitivity → case-fold the group body, drop the flag
  src = expandScopedI(src);
  // a mid-pattern (?i): case-fold everything after it (a leading literal, e.g.
  // "p8e-", stays case-sensitive — which the i flag could not express)
  const mid = src.indexOf('(?i)');
  if (mid !== -1) {
    src = src.slice(0, mid) + caseFold(src.slice(mid + 4));
  }
  // any remaining inline flag group we do not handle → refuse
  const unknown = src.match(/\(\?[a-zA-Z]*[):]/);
  if (
    unknown &&
    !unknown[0].startsWith('(?:') &&
    !unknown[0].startsWith('(?<') &&
    !/^\(\?[=!]/.test(unknown[0])
  )
    throw new PortError(`unhandled inline group ${unknown[0]}`);
  // it must compile as a Node RegExp
  try {
    new RegExp(src, flags);
  } catch (e) {
    throw new PortError(`does not compile: ${e.message}`);
  }
  return { source: src, flags };
}

/** Replace every (?i:…) with its case-folded body wrapped in (?:…). */
function expandScopedI(src) {
  let out = '';
  for (let i = 0; i < src.length; i += 1) {
    if (src.startsWith('(?i:', i)) {
      // find the matching close paren, respecting nested () and [] and escapes
      let depth = 1;
      let j = i + 4;
      let inClass = false;
      for (; j < src.length && depth > 0; j += 1) {
        const c = src[j];
        if (c === '\\') {
          j += 1;
          continue;
        }
        if (inClass) {
          if (c === ']') inClass = false;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === '(') depth += 1;
        else if (c === ')') depth -= 1;
      }
      if (depth !== 0) throw new PortError('unterminated (?i: group');
      const body = src.slice(i + 4, j - 1);
      out += `(?:${caseFold(expandScopedI(body))})`;
      i = j - 1;
    } else {
      out += src[i];
    }
  }
  return out;
}

/** Minimal TOML read for gitleaks' generated file: the global allowlist and [[rules]]. */
export function parseToml(text) {
  const lines = text.split('\n');
  const rules = [];
  const allowlistRegexes = [];
  let section = null; // 'allowlist' | 'rules' | 'other'
  let cur = null;
  const tripleArray = (startIdx) => {
    // collect '''…''' entries of an array that may span lines until a line is ']'
    const items = [];
    for (let k = startIdx; k < lines.length; k += 1) {
      const l = lines[k];
      for (const m of l.matchAll(/'''((?:[^']|'(?!''))*)'''/g)) items.push(m[1]);
      if (l.trim() === ']') return { items, end: k };
    }
    return { items, end: lines.length - 1 };
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const t = line.trim();
    if (t === '[allowlist]') {
      section = 'allowlist';
      continue;
    }
    if (t === '[[rules]]') {
      section = 'rules';
      cur = { keywords: [] };
      rules.push(cur);
      continue;
    }
    if (t.startsWith('[') && t !== '[allowlist]' && t !== '[[rules]]') {
      // any other table (e.g. [allowlist] sub-tables) — leave the rule section
      if (!t.startsWith('[[rules.')) section = 'other';
      continue;
    }
    if (section === 'allowlist' && t.startsWith('regexes')) {
      const { items, end } = tripleArray(i);
      allowlistRegexes.push(...items);
      i = end;
      continue;
    }
    if (section === 'rules' && cur) {
      let m;
      if ((m = t.match(/^id\s*=\s*"(.*)"$/))) cur.id = m[1];
      else if ((m = t.match(/^regex\s*=\s*'''(.*)'''$/))) cur.regex = m[1];
      else if ((m = t.match(/^entropy\s*=\s*([\d.]+)$/))) cur.entropy = Number(m[1]);
      else if (t.startsWith('keywords')) {
        const inline = t.match(/\[(.*)\]/);
        const body = inline
          ? inline[1]
          : lines
              .slice(i + 1)
              .join(' ')
              .split(']')[0];
        cur.keywords = [...body.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
      }
    }
  }
  return { rules, allowlistRegexes };
}

/** Build the generated-module text from the parsed, translated rules. */
export function generate(text) {
  const { rules, allowlistRegexes } = parseToml(text);
  if (rules.length === 0) throw new PortError('no rules parsed from the gitleaks config');
  const ported = [];
  const refused = [];
  for (const r of rules) {
    if (!r.id || !r.regex) {
      refused.push({ id: r.id ?? '(no id)', why: 'missing id or regex' });
      continue;
    }
    try {
      const { source, flags } = translate(r.regex);
      ported.push({ id: r.id, source, flags, keywords: r.keywords ?? [], entropy: r.entropy ?? 0 });
    } catch (e) {
      refused.push({ id: r.id, why: e.message });
    }
  }
  const allow = [];
  for (const a of allowlistRegexes) {
    try {
      const { source, flags } = translate(a);
      allow.push({ source, flags });
    } catch (e) {
      refused.push({ id: `allowlist:${a.slice(0, 20)}`, why: e.message });
    }
  }
  ported.sort((a, b) => a.id.localeCompare(b.id));
  const body = [
    '// SPDX-License-Identifier: AGPL-3.0-only',
    '//',
    '// GENERATED by scripts/gitleaks-port.mjs from config/gitleaks.toml — do not edit by hand.',
    `// Source: gitleaks (MIT, (c) Zachary Rice), tag ${PINNED.tag} commit ${PINNED.commit}.`,
    `// ${ported.length} rules ported, ${refused.length} refused (listed in REFUSED).`,
    '',
    `export const PINNED = ${JSON.stringify(PINNED)};`,
    '',
    'export const GITLEAKS_RULES = [',
    ...ported.map(
      (r) =>
        `  { id: ${JSON.stringify(r.id)}, re: ${JSON.stringify(r.source)}, flags: ${JSON.stringify(r.flags)}, keywords: ${JSON.stringify(r.keywords)}, entropy: ${r.entropy} },`,
    ),
    '];',
    '',
    'export const GITLEAKS_ALLOWLIST = [',
    ...allow.map(
      (a) => `  { re: ${JSON.stringify(a.source)}, flags: ${JSON.stringify(a.flags)} },`,
    ),
    '];',
    '',
    `export const REFUSED = ${JSON.stringify(refused, null, 2)};`,
    '',
  ].join('\n');
  return { body, ported, refused, allow };
}

export function runPort({ write = false } = {}) {
  const text = readFileSync(TOML_PATH, 'utf8');
  const { body, ported, refused, allow } = generate(text);
  if (write) writeFileSync(OUT_PATH, body);
  return { body, ported, refused, allow };
}

if (process.argv[1] && process.argv[1].endsWith('gitleaks-port.mjs')) {
  const { ported, refused, allow } = runPort({ write: process.argv.includes('--write') });
  console.log(
    `gitleaks-port: ${ported.length} rules ported, ${allow.length} allowlist regexes, ${refused.length} refused` +
      (process.argv.includes('--write') ? ` → ${OUT_PATH}` : ' (dry run; pass --write)'),
  );
  if (refused.length) for (const r of refused) console.log(`  refused ${r.id}: ${r.why}`);
}
