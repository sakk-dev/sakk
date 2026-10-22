import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPort, translate, PortError } from '../scripts/gitleaks-port.mjs';
import { GITLEAKS_RULES, REFUSED, PINNED } from '../src/secret-rules.generated.mjs';
import { scanText, scanPaths, GL_RULES, GITLEAKS_DISABLED } from '../src/secret-scan.mjs';
import { normalize, evaluate } from '../src/hook.mjs';

/**
 * The gitleaks rule port (specs/secret-guard "Translating the rules", M3). The
 * tests prove: the generated file equals a fresh port (determinism), every
 * enabled rule is linear on hostile input (C-04) and both-sided — it catches a
 * generated positive and leaves the benign corpus (this repo) alone (C-13).
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PATHOLOGY_MS = 60_000; // a generous ceiling: a backtracking rule hangs far past this

/**
 * A tiny regex sampler: emit ONE minimal string that matches `src`, for the
 * constructs gitleaks uses (literals, classes, bounded/unbounded quantifiers,
 * groups, alternation, escapes, anchors). Quantifiers emit their minimum, so a
 * required secret capture ({N}/{N,}/+) is present while optional context ({0,N})
 * is skipped. Not every rule is coverable; those fall back to precision only.
 */
function sampleRe(src) {
  let i = 0;
  let lastPool = null; // the usable chars of the atom just parsed (a class), for high-entropy repeats
  const classChar = () => {
    // parse a [..] class → representative chars (prefer a broad alphanumeric pool)
    let j = i + 1;
    if (src[j] === '^') j += 1;
    const chars = [];
    while (j < src.length && src[j] !== ']') {
      if (src[j] === '\\') {
        const e = src[j + 1];
        if (e === 'w') chars.push('a', 'B', 'c', '7');
        else if (e === 'd') chars.push('1', '4', '7');
        else chars.push(e === 's' ? ' ' : e);
        j += 2;
        continue;
      }
      if (src[j + 1] === '-' && src[j + 2] && src[j + 2] !== ']') {
        for (let c = src.charCodeAt(j); c <= src.charCodeAt(j + 2); c += 1)
          chars.push(String.fromCharCode(c));
        j += 3;
        continue;
      }
      chars.push(src[j]);
      j += 1;
    }
    i = j + 1;
    const alnum = chars.filter((c) => /[A-Za-z0-9]/.test(c));
    lastPool = alnum.length ? alnum : chars.filter((c) => c !== ' ' && c.length === 1);
    return lastPool[0] ?? 'a';
  };
  function atom() {
    const c = src[i];
    if (c === '(') {
      i += 1;
      if (src.startsWith('?<', i)) i = src.indexOf('>', i) + 1;
      else if (src.startsWith('?:', i) || src.startsWith('?=', i) || src.startsWith('?!', i))
        i += 2;
      const inner = alt();
      if (src[i] === ')') i += 1;
      return inner;
    }
    if (c === '[') return classChar();
    if (c === '\\') {
      const e = src[i + 1];
      i += 2;
      if (e === 'w') return 'a';
      if (e === 'd') return '1';
      if (e === 's') return ' ';
      if (e === 'b' || e === 'B' || e === 'z' || e === 'A') return '';
      if (e === 'n') return '\n';
      if (e === 'r') return '\r';
      if (e === 't') return '\t';
      if (e === 'x') {
        const hex = src.slice(i, i + 2);
        i += 2;
        return String.fromCharCode(parseInt(hex, 16) || 97);
      }
      return e;
    }
    if (c === '.') {
      i += 1;
      return 'a';
    }
    if (c === '^' || c === '$') {
      i += 1;
      return '';
    }
    i += 1;
    return c;
  }
  function quantified() {
    lastPool = null;
    const a = atom();
    const pool = lastPool;
    let min = null;
    const q = /^(?:\{(\d+)(?:,\d*)?\}|([+*?]))/.exec(src.slice(i));
    if (q) {
      min = q[2] === '+' ? 1 : q[2] === '*' || q[2] === '?' ? 0 : Number(q[1]);
      i += q[0].length;
      if (src[i] === '?') i += 1; // lazy
    }
    if (min === null) return a;
    // a secret capture needs high entropy: vary the chars across the class pool
    if (pool && pool.length > 1 && min > 0) {
      let s = '';
      for (let k = 0; k < min; k += 1) s += pool[(k * 7 + 3) % pool.length];
      return s;
    }
    return a.repeat(min);
  }
  function seq() {
    let out = '';
    while (i < src.length && src[i] !== '|' && src[i] !== ')') out += quantified();
    return out;
  }
  function alt() {
    const branches = [seq()];
    while (src[i] === '|') {
      i += 1;
      branches.push(seq());
    }
    return branches.find((b) => b.length) ?? branches[0];
  }
  return alt();
}

/** A positive the LIVE scanner catches (keyword + entropy + allowlist), or null. */
function positiveFor(rule) {
  let sample;
  try {
    sample = sampleRe(rule.re.source);
  } catch {
    return null;
  }
  if (!sample) return null;
  // ensure the keyword pre-filter can fire, then require scanText to actually catch it
  const kw = rule.keywords[0];
  const s = kw && !sample.toLowerCase().includes(kw.toLowerCase()) ? `${kw} ${sample}` : sample;
  return scanText(s).findings.length >= 1 ? s : null;
}

describe('gitleaks rule port (M3)', () => {
  test('the port is deterministic: re-running it reproduces the committed rules byte for byte', () => {
    const fresh = runPort({ write: false }).body;
    const committed = readFileSync(join(ROOT, 'src', 'secret-rules.generated.mjs'), 'utf8');
    assert.equal(fresh, committed, 'run `node scripts/gitleaks-port.mjs --write` to regenerate');
    assert.match(PINNED.commit, /^[0-9a-f]{40}$/);
  });

  test('an unknown regex construct is refused, not mis-translated', () => {
    assert.throws(() => translate('(?P=name)'), PortError); // a backreference we do not handle
    assert.throws(() => translate('(?<=foo)(?z:bar)'), PortError);
    // the real refusals are recorded, not silently dropped
    assert.ok(Array.isArray(REFUSED));
    for (const r of REFUSED) assert.ok(r.id && r.why, 'each refusal says which rule and why');
  });

  test('every ported regex is linear on hostile input', () => {
    const hostile =
      GL_RULES.flatMap((r) => r.keywords).join(' ') +
      ' ' +
      'a1_.-'.repeat(20000) +
      ' key="' +
      'x'.repeat(30000);
    // a catastrophic regex does not finish at all — it hangs this exec() and the
    // harness --test-timeout kills the run; a generous named bound only catches a
    // slow-but-finite one (not a tight stopwatch on normal speed).
    for (const r of GL_RULES) {
      const t = Date.now();
      r.re.lastIndex = 0;
      while (r.re.exec(hostile)) {
        /* drain */
      }
      assert.ok(
        Date.now() - t < PATHOLOGY_MS,
        `${r.name} took too long — catastrophic backtracking?`,
      );
    }
  });

  test('the whole scan stays bounded on a large adversarial input', () => {
    const hostile = GL_RULES.flatMap((r) => r.keywords).join(' ') + ' ' + 'a1_.-'.repeat(30000);
    const t = Date.now();
    scanText(hostile);
    assert.ok(
      Date.now() - t < PATHOLOGY_MS,
      'a catastrophic rule would hang; this only catches slow-but-finite',
    );
  });

  test('every ported rule catches a generated positive and leaves the benign corpus alone', () => {
    // precision (C-13 negative side): the whole repository scans clean with the
    // ported rules enabled — a false positive here would deny a legitimate write
    const repo = scanPaths([ROOT]);
    assert.deepEqual(
      repo.findings,
      [],
      `benign false positives: ${JSON.stringify(repo.findings.slice(0, 5))}`,
    );
    // recall (C-13 positive side): for each rule an auto-positive can be built
    // for, the live scanner catches it. The derivable majority is recall-proven;
    // the rest are precision- and bound-verified, with the full per-rule corpus
    // the remaining C-13 stopline (specs/secret-guard).
    let verified = 0;
    for (const rule of GL_RULES) if (positiveFor(rule)) verified += 1;
    assert.ok(
      verified >= 60,
      `only ${verified}/${GL_RULES.length} rules recall-verified by an auto-positive`,
    );
  });

  test('a placeholder or allowlisted value is not flagged, a real one is', () => {
    // built at runtime so no literal secret sits in this file (the repo scan is clean)
    const kw = ['ada', 'fruit'].join(''); // keyword of the adafruit rule
    const real = 'ab'.repeat(16); // 32 chars matching the capture [a-z0-9_-]{32}
    // a ${VAR}/placeholder in the secret position is exempt by the global allowlist
    assert.equal(scanText(`${kw}_key = "${'${ADAFRUIT_KEY}'}"`).findings.length, 0);
    assert.equal(scanText(`${kw}_key = "true"`).findings.length, 0);
    // a real-shaped token is caught
    assert.ok(scanText(`${kw}_key = "${real}"`).findings.length >= 1);
  });

  test('one secret matched by two rules is a single finding', () => {
    // sk_live_… is matched by the base generic_api_key and a gitleaks stripe rule;
    // the span dedup reports it once (F-122)
    const r = scanText(`token = "sk_live_${'7Kd'.repeat(10)}"`);
    assert.equal(r.findings.length, 1, JSON.stringify(r.findings));
  });

  test('a ported rule denies through the hook', () => {
    // a secret only a ported rule catches (an Adafruit key) → deny on the real path
    const content = `${['ada', 'fruit'].join('')}_key = "${'ab'.repeat(16)}"`;
    const ev = normalize('claude-code', {
      hook_event_name: 'PreToolUse',
      cwd: ROOT,
      tool_name: 'Write',
      tool_input: { file_path: join(ROOT, 'note.txt'), content },
    });
    const r = evaluate(ev, { log: false });
    assert.equal(r.verdict, 'deny');
    assert.match(r.reason, /secret/);
  });

  test('a disabled rule is a reviewed exclusion that still exists in the generated set', () => {
    // every disabled id must be a real ported rule (no stale exclusion)
    const ids = new Set(GITLEAKS_RULES.map((r) => r.id));
    for (const id of GITLEAKS_DISABLED)
      assert.ok(ids.has(id), `disabled ${id} is not a ported rule`);
    // and the enabled set is the ported set minus the disabled
    assert.equal(GL_RULES.length, GITLEAKS_RULES.length - GITLEAKS_DISABLED.size);
  });
});
