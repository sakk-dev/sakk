import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
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
    const PLANNED = new Set(['spend', 'cap', 'prices', 'settle']); // README roadmap / CHANGELOG "not shipped"
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
