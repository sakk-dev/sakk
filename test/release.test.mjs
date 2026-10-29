import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Release packaging (open-source v1, M5): the npm package and the Claude Code
 * plugin. Tests run the REAL `npm pack` and read the REAL manifests, so a
 * shipped dev file, a broken plugin hook, a documented-but-missing command
 * (F-161) or a split version number fails the build.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const pkg = JSON.parse(read('package.json'));

/** The real packed file list, from `npm pack --dry-run --json`. */
function packedFiles() {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const json = out.slice(out.indexOf('['), out.lastIndexOf(']') + 1);
  return JSON.parse(json)[0].files.map((f) => f.path.replace(/^\.\//, ''));
}

/** Every `sakk <subcommand>` the CLI actually implements, read from the source. */
function cliCommands() {
  const bin = read('bin/sakk.mjs');
  const cmds = new Set();
  for (const m of bin.matchAll(/^ {2}([a-z][a-z-]*): \{ (?:values|bools):/gm)) cmds.add(m[1]);
  // handled outside the COMMANDS table
  for (const m of bin.matchAll(/cmd === '([a-z][a-z-]*)'/g)) cmds.add(m[1]);
  return cmds;
}

/** The text inside backticks (inline code and fenced blocks) — command contexts only, not prose. */
function codeSpans(md) {
  const fences = [...md.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const noFence = md.replace(/```[a-z]*\n[\s\S]*?```/g, '');
  const inline = [...noFence.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  return [...fences, ...inline].join('\n');
}

/** Bullets and paragraphs, each with its continuation lines (fenced blocks dropped). */
function docBlocks(md) {
  const blocks = [];
  let cur = null;
  for (const line of md.replace(/```[a-z]*\n[\s\S]*?```/g, '').split('\n')) {
    if (!line.trim()) cur = null;
    else if (!cur || /^\s*(?:[-*] |#)/.test(line)) blocks.push((cur = [line]));
    else cur.push(line);
  }
  return blocks.map((b) => b.join('\n'));
}

/** How the docs say a command is not in this release. */
const NOT_SHIPPED = /not shipped|\bplanned\b|on the roadmap|^\s*- \[ \]/im;

describe('release packaging (M5)', () => {
  test('the published files all exist and exclude tests, specs and findings', () => {
    for (const f of pkg.files)
      assert.ok(existsSync(join(ROOT, f)), `files entry missing on disk: ${f}`);
    const packed = packedFiles();
    // dev-only trees must never ship, derived from the repo (not a hand list of one or two)
    const forbidden = [
      'test/',
      'specs/',
      'findings/',
      'eval/',
      'scripts/',
      'node_modules/',
      '.github/',
      '.claude/',
    ];
    for (const p of packed)
      for (const bad of forbidden) assert.ok(!p.startsWith(bad), `dev file shipped: ${p}`);
    // the code and the plugin that must ship are there
    for (const need of [
      'package.json',
      'bin/sakk.mjs',
      'src/console.mjs',
      '.claude-plugin/plugin.json',
      'LICENSE',
    ])
      assert.ok(packed.includes(need), `missing from the package: ${need}`);
  });

  test('the Claude Code plugin manifest is valid and its hook runs the installed sakk', () => {
    const m = JSON.parse(read('.claude-plugin/plugin.json'));
    assert.equal(m.name, 'sakk');
    assert.match(m.version, /^\d+\.\d+\.\d+$/);
    const entry = m.hooks.PreToolUse[0];
    assert.equal(entry.matcher, '*'); // every tool call is judged
    const h = entry.hooks[0];
    assert.equal(h.type, 'command');
    assert.equal(h.command, 'node');
    assert.deepEqual(h.args.slice(1), ['hook', '--agent', 'claude-code']);
    assert.match(h.args[0], /^\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/sakk\.mjs$/);
    assert.equal(h.onFailure, 'block'); // fail-closed: a hook that cannot run blocks the call
    assert.ok(existsSync(join(ROOT, 'bin', 'sakk.mjs')), 'the hook target exists');
  });

  test('every command the README shows is a real sakk subcommand', () => {
    // F-161: the docs may not promise a `sakk <cmd>` the binary does not have.
    // Real commands come from the source; a few are explicitly PLANNED and the
    // docs mark them not-shipped — anything else that is named fails.
    const real = cliCommands();
    const PLANNED = new Set(['settle']); // the one command still on the roadmap (cap/spend/prices now ship)
    // scan only command contexts (backticks / fenced blocks), never prose
    const docs = codeSpans(read('README.md')) + '\n' + codeSpans(read('CHANGELOG.md'));
    const named = [...new Set([...docs.matchAll(/\bsakk ([a-z][a-z-]+)/g)].map((m) => m[1]))];
    const unknown = named.filter((c) => !real.has(c) && !PLANNED.has(c));
    assert.deepEqual(
      unknown,
      [],
      'the docs name a sakk command that is neither implemented nor a declared planned one',
    );
    // A PLANNED command is excused only where the docs say it is not shipped:
    // the bullet or paragraph that names it must carry a not-shipped marker.
    // (The first version of this test let M2's "`sakk cap set` ..." pass,
    // because PLANNED excused the name wherever it appeared.)
    const unmarked = [];
    for (const f of ['README.md', 'CHANGELOG.md'])
      for (const block of docBlocks(read(f)))
        for (const m of block.matchAll(/`[^`\n]*\bsakk ([a-z][a-z-]+)[^`\n]*`/g))
          if (PLANNED.has(m[1]) && !real.has(m[1]) && !NOT_SHIPPED.test(block))
            unmarked.push(`${f}: ${block.split('\n')[0].slice(0, 80)}`);
    assert.deepEqual(
      [...new Set(unmarked)],
      [],
      'a planned command is named without saying it is not shipped',
    );
    // controls: the detector can fail — a fake command is caught, an unmarked planned one too
    assert.ok(!real.has('definitelynotacommand'));
    assert.ok(!NOT_SHIPPED.test('- `sakk cap set <usd>`: a daily cap the guard enforces'));
  });

  test('the version is one source of truth across the binary and the plugin', () => {
    const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
    assert.equal(plugin.version, pkg.version, 'plugin.json and package.json versions differ');
    const printed = execFileSync(process.execPath, [join(ROOT, 'bin', 'sakk.mjs'), '--version'], {
      encoding: 'utf8',
    }).trim();
    assert.equal(printed, pkg.version, 'sakk --version differs from package.json');
  });
});

/**
 * P0 UAT backfill — install and accuracy cases that automation can stand on
 * (P-INS / P-ACC). Each test pins a behaviour or a shipped claim so that
 * removing the behaviour, or the sentence in the docs that promises it, turns
 * this suite red (the C-05 discipline: a documented claim must be backed by a
 * test that fails without it). Where a case is genuinely half-manual (a real
 * Claude Code installing, uninstalling and firing the plugin), the automatable
 * half is pinned here and the manual half is named, never faked green.
 */
describe('P0 UAT backfill — install & accuracy (P-INS / P-ACC)', () => {
  // run the real CLI and return {status, out} without the test throwing on a
  // non-zero exit (execFileSync throws then; we want to assert on the code).
  const runCli = (args, env = {}) => {
    try {
      const out = execFileSync(process.execPath, [join(ROOT, 'bin', 'sakk.mjs'), ...args], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, out };
    } catch (e) {
      return { status: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  };

  test('P-INS-001 `sakk init` creates a ledger, refuses to overwrite it, and installs no agent hook', () => {
    const base = mkdtempSync(join(tmpdir(), 'sakk-init-'));
    try {
      const home = join(base, 'home');
      const ledger = join(base, 'ledger.json');
      const env = { HOME: home, SAKK_HOME: join(home, '.sakk') };

      // create
      const first = runCli(['init', '--cap', '5', '--ledger', ledger], env);
      assert.equal(first.status, 0, `init should succeed: ${first.out}`);
      assert.ok(existsSync(ledger), 'init creates the ledger file');
      const created = readFileSync(ledger, 'utf8');
      const doc = JSON.parse(created);
      assert.equal(doc.capUsd, 5, 'the cap is recorded');
      assert.deepEqual(doc.entries, [], 'a fresh ledger has no entries');

      // refuse to overwrite — non-zero exit AND the ledger left byte-identical
      const second = runCli(['init', '--cap', '9', '--ledger', ledger], env);
      assert.notEqual(second.status, 0, 'a second init must NOT exit 0 (it refused)');
      assert.match(second.out, /LEDGER_ALREADY_EXISTS/, 'the refusal names the ledger-exists code');
      assert.equal(
        readFileSync(ledger, 'utf8'),
        created,
        'the existing ledger is untouched (cap stays 5)',
      );

      // init records the ledger for the installed guard in Sakk's own config
      // (F-172) and nothing else: it is not guard-install, so it never writes a
      // Claude Code / Cursor / Codex hook config. The guard would write
      // <home>/.claude/settings.json (src/guard-install.mjs configPath); init
      // must not have created it.
      assert.equal(
        JSON.parse(readFileSync(join(home, '.sakk', 'config.json'), 'utf8')).ledgerPath,
        ledger,
        'init records the ledger path the hook reads',
      );
      assert.ok(
        !existsSync(join(home, '.claude', 'settings.json')),
        'init did not wire a claude-code hook',
      );
      assert.ok(
        !existsSync(join(home, '.cursor', 'hooks.json')),
        'init did not wire a cursor hook',
      );
      assert.ok(!existsSync(join(home, '.codex', 'hooks.json')), 'init did not wire a codex hook');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('P-INS-003 every relative import of a shipped module resolves to a file that is in the tarball', () => {
    // "runs from the packed files": the package carries code that reaches
    // outside the `files` whitelist only through node: builtins. If any shipped
    // .mjs imported a path npm will not pack (a dev tree, a stray helper), the
    // installed package would throw at import time. Resolve every relative
    // import against the real packed file list.
    const packed = new Set(packedFiles());
    const shippedMjs = [...packed].filter(
      (p) => p.endsWith('.mjs') && (p.startsWith('src/') || p.startsWith('bin/')),
    );
    assert.ok(
      shippedMjs.length >= 5,
      `the package ships the code (found ${shippedMjs.length} .mjs)`,
    );
    const missing = [];
    for (const rel of shippedMjs) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      const dir = dirname(join(ROOT, rel));
      for (const m of src.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
        const target = relative(ROOT, resolve(dir, m[1]));
        if (!packed.has(target))
          missing.push(`${rel} -> ${m[1]} (resolves to ${target}, not packed)`);
      }
    }
    assert.deepEqual(
      missing,
      [],
      'a shipped module imports a file that the tarball does not carry',
    );
  });

  test('P-ACC-003 the README documents the five REQ-P04 limits, the confirmation limit and the five limits of the core', () => {
    // REQ-P04 (the original requirements, decision D7 2026-10-28) names five
    // limits the README must state, because docs/ does not ship in the npm
    // package: a constructed command is only asked or denied; @ references skip
    // the hook; the cap acts at the next tool call; the agent can change local
    // logs; older Claude Code fails open. Each is pinned by its heading and the
    // words that make it concrete, so it cannot be dropped or blurred unnoticed.
    const readme = read('README.md');
    const anchor = /^Know these limits of the open core before relying on it:/m;
    assert.match(readme, anchor, 'the README has a "limits of the open core" section');
    const section = readme.slice(readme.search(anchor), readme.search(/^## License/m));
    const limits = [...section.matchAll(/^- \*\*([^*]+)\*\*/gm)].map((m) => m[1].trim());
    assert.deepEqual(
      limits.slice(0, 5),
      [
        'It reads a command as written.',
        '`@` references skip the hook.',
        'The cap stops the next call, not the one that crosses it.',
        'The logs are local files the agent can reach.',
        'Older Claude Code fails open.',
      ],
      'the five REQ-P04 limits lead the section, in order',
    );
    const words = (heading) => {
      const at = section.indexOf(`- **${heading}**`);
      const next = section.indexOf('\n- **', at + 1);
      return section.slice(at, next === -1 ? undefined : next);
    };
    const constructed = words('It reads a command as written.');
    assert.match(constructed, /can only be asked or\s+denied/, 'REQ-P04 1: constructed → ask/deny');
    // the F-173 boundary (D5), narrowed by F-176: a variable or brace
    // expansion is asked, never allowed (test/guard.test.mjs), while a glob or
    // a program's own run-time pick stays allowed (test/secret-guard.test.mjs).
    // Each form is named here so the README and the guard cannot drift apart.
    for (const form of [
      'cat .e*',
      'cat .e{nv,x}',
      'f=.env; cat $f',
      'grep -r',
      'find … -exec cat',
      'xargs',
      'f=~/.sakk/config.json; rm $f',
      'o=--force; git push $o',
    ]) {
      assert.ok(constructed.includes(form), `the boundary names ${form}`);
    }
    assert.match(
      constructed,
      /asked, never\s+allowed/,
      'F-176: an expansion-held form is asked, never allowed',
    );
    assert.match(words('`@` references skip the hook.'), /@-mention/, 'REQ-P04 2');
    assert.match(
      words('The cap stops the next call, not the one that crosses it.'),
      /go over by one\s+response/,
      'REQ-P04 3',
    );
    assert.match(
      words('The logs are local files the agent can reach.'),
      /can\s+rewrite them/,
      'REQ-P04 4',
    );
    assert.match(words('Older Claude Code fails open.'), /2\.1\.295/, 'REQ-P04 5');
    // F-171: the terminal check is not proof of a person; F-177: the halt
    // family is denied to the agent and the default ledger lives under
    // ~/.sakk, so the remaining limit is the trusted summary itself
    assert.match(
      words('The confirmation checks for a terminal, not a person.'),
      /pseudo-terminal[\s\S]*`npx sakk cap off`/,
      'F-171 limit',
    );
    assert.match(
      words("The ledger's summary is trusted."),
      /denies[\s\S]*`resume`, `reconcile` and `unlock`[\s\S]*~\/\.sakk\/sakk-ledger\.json[\s\S]*ledger verify/,
      'F-177 limit',
    );
    assert.equal(
      limits.length,
      11,
      `six guard limits and five core limits (found ${limits.length})`,
    );
    // each documented limit is about a real surface — tie the words to the code,
    // so a limit cannot be deleted (or turned into vague prose) unnoticed.
    assert.ok(/self-declared/i.test(section), 'documents that --by names are self-declared');
    assert.ok(/caller reports|reports/i.test(section), 'documents that costs are caller-reported');
    assert.ok(/approval/i.test(section), 'documents that approval-required means refused');
    assert.ok(/voluntary|never calls/i.test(section), 'documents that gating is voluntary');
  });

  test('P-ACC-005 enterprise / login / regulatory features are an honest stub, never claimed shipped', () => {
    // the enterprise console page is a coming-soon stub that says so
    const console_ = read('src/console.mjs');
    assert.match(
      console_,
      /Enterprise\s*\\u00b7\s*coming soon|Enterprise · coming soon/,
      'the enterprise page is a coming-soon stub',
    );
    assert.match(
      console_,
      /Not shown in the open-source edition/,
      'the stub says the feature is not in the open-source edition',
    );
    // the README roadmap marks the enterprise items UNCHECKED ([ ]), never [x]
    const roadmap = read('README.md');
    const enterpriseLines = roadmap
      .split('\n')
      .filter(
        (l) =>
          /^\s*- \[[ x]\]/.test(l) && /enterprise|\bSSO\b|Team console|Named-approver/i.test(l),
      );
    assert.ok(
      enterpriseLines.length >= 2,
      `the roadmap lists the enterprise items (found ${enterpriseLines.length})`,
    );
    for (const l of enterpriseLines)
      assert.match(
        l,
        /^\s*- \[ \]/,
        `an enterprise item must be unshipped ([ ]), not claimed done: ${l.trim()}`,
      );
  });

  test('P-ACC-008 third-party work (gitleaks, LiteLLM) is attributed in the shipped files', () => {
    // NOTE (the maintainer decision, surfaced in the report): whether attribution must also
    // ship the FULL MIT licence text (not just the (c) line) is a release/legal
    // call. This test pins the necessary condition — the credit ships — not that
    // it is legally sufficient.
    const packed = new Set(packedFiles());
    const rules = read('src/secret-rules.generated.mjs');
    assert.match(
      rules,
      /gitleaks \(MIT, \(c\) Zachary Rice\)/,
      'the ported rules credit gitleaks, MIT, the copyright holder',
    );
    assert.match(
      rules,
      /tag v\d+\.\d+\.\d+ commit [0-9a-f]{7,}/,
      'the credit pins the upstream tag and commit',
    );
    assert.ok(packed.has('src/secret-rules.generated.mjs'), 'the credited file actually ships');
    const prices = read('prices/snapshot.json');
    assert.match(prices, /LiteLLM/, 'the price snapshot names LiteLLM as the refresh source');
    assert.ok(packed.has('prices/snapshot.json'), 'the price snapshot actually ships');
  });

  test('P-ACC-009 no competitor-licensed (dcg) rules or code appear in any shipped file', () => {
    // dcg's licence rider excludes Anthropic, so its rules were deliberately NOT
    // borrowed (specs/guard/decide.md records the decision, and specs/ does not
    // ship). This pins the result: the identifier appears in no packed file.
    const packed = packedFiles().filter((p) => /\.(mjs|json|md|toml)$/.test(p));
    const hits = [];
    for (const p of packed) {
      if (/\bdcg\b/i.test(readFileSync(join(ROOT, p), 'utf8'))) hits.push(p);
    }
    assert.deepEqual(
      hits,
      [],
      'a shipped file mentions dcg — the non-borrow decision may have been undone',
    );
    // control: the decision itself is recorded in the (unshipped) spec
    assert.match(
      read('specs/guard/decide.md'),
      /\bdcg\b/,
      'the non-borrow decision is on the record in the spec',
    );
    assert.ok(
      !packed.includes('specs/guard/decide.md'),
      'and that spec is not part of the package',
    );
  });

  test('P-INS-008..011 the Claude Code plugin install is wired correctly (CC-side install/uninstall/fire is manual)', () => {
    // AUTOMATABLE half: the shipped manifest is a valid Claude Code plugin whose
    // hook points at the packed binary and is fail-closed, and the README's
    // install instructions match that manifest. (The manifest's validity +
    // onFailure:'block' is also asserted by the M5 test above; here we pin the
    // README<->manifest agreement that the install steps depend on.)
    const packed = new Set(packedFiles());
    assert.ok(packed.has('.claude-plugin/plugin.json'), 'the plugin manifest ships');
    const m = JSON.parse(read('.claude-plugin/plugin.json'));
    assert.equal(m.name, 'sakk', 'the plugin name the README tells people to add');
    const readme = read('README.md');
    const install = readme.slice(readme.search(/^## Install/m));
    assert.match(install, /\bsakk\b/, 'the Install section names the plugin');
    // the hook target the manifest installs must be a file the package carries,
    // or an install into a real Claude Code would wire a missing path.
    const hookTarget = m.hooks.PreToolUse[0].hooks[0].args[0].replace('${CLAUDE_PLUGIN_ROOT}/', '');
    assert.ok(packed.has(hookTarget), `the hook target (${hookTarget}) ships in the package`);
    //
    // MANUAL half (NOT automated here, and not faked): installing the plugin into
    // a running Claude Code (P-INS-008), uninstalling it (P-INS-009), confirming
    // the PreToolUse hook actually fires on a tool call inside Claude Code
    // (P-INS-010), and that a denied call is blocked end-to-end in the product
    // (P-INS-011). These need a live Claude Code and are verified by hand.
    assert.ok(true, 'automatable half pinned; CC-side install/uninstall/fire verified manually');
  });
});
