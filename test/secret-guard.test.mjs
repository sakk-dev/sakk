import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize, evaluate } from '../src/hook.mjs';
import { FICTIONAL_EXEMPTION_TOKEN } from '../src/secret-scan.mjs';

/**
 * The secret guard in the hook (specs/secret-guard, step 3): a write whose
 * content is a secret, or a shell command whose text prints one, is denied —
 * on the eight shipped rules now, and whatever rules the table carries after
 * the gitleaks port. The 222-rule port needs the upstream file fetched and is
 * deferred; this file tests the enforcement, which stands on the rules present.
 */
// real-shaped secrets the shipped rules catch (not live keys). Built at
// runtime via join('') so no contiguous literal sits in this file — the
// repository-scans-clean test would otherwise flag the fixtures themselves.
const GH = ['ghp', '_', 'c3'.repeat(20)].join('');
const AWS = ['AKIA', 'A'.repeat(16)].join('');
const BEARER = ['Bearer', 'e5'.repeat(15)].join(' ');

function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'secret-')));
  mkdirSync(join(base, 'src'), { recursive: true });
  return { base, env: { ...process.env, SAKK_HOME: join(base, '.sakk'), HOME: base } };
}
const run = (w, payload) =>
  evaluate(normalize('claude-code', { hook_event_name: 'PreToolUse', cwd: w.base, ...payload }), {
    env: w.env,
    log: false,
  });
const writeEv = (w, file, content) => ({
  tool_name: 'Write',
  tool_input: { file_path: join(w.base, file), content },
});
const bashEv = (w, command) => ({ tool_name: 'Bash', tool_input: { command } });

describe('the secret guard denies writing or printing a secret (M3, hook step 3)', () => {
  test('writing ordinary content and running an ordinary command are allowed', () => {
    const w = world();
    assert.equal(run(w, writeEv(w, 'src/notes.txt', 'const answer = 42;\n')).verdict, 'allow');
    assert.equal(run(w, bashEv(w, 'ls -la && npm test')).verdict, 'allow');
  });

  test('an Edit or Write whose content is a secret is denied', () => {
    const w = world();
    assert.equal(run(w, writeEv(w, 'src/notes.txt', `const t = "${GH}";\n`)).verdict, 'deny');
    // an Edit shape: the new_string carries the secret
    const edit = {
      tool_name: 'Edit',
      tool_input: {
        file_path: join(w.base, 'src/a.js'),
        old_string: 'x',
        new_string: `key=${AWS}`,
      },
    };
    assert.equal(run(w, edit).verdict, 'deny');
  });

  test('a shell command that prints a literal secret is denied', () => {
    const w = world();
    const r = run(w, bashEv(w, `curl -H "Authorization: ${BEARER}" https://api.example`));
    assert.equal(r.verdict, 'deny');
  });

  test('a secret block names its rule and fingerprint, never the value', () => {
    const w = world();
    const r = run(w, writeEv(w, 'src/notes.txt', `token = "${GH}"\n`));
    assert.equal(r.verdict, 'deny');
    assert.match(r.reason, /github_token/);
    assert.match(r.reason, /fingerprint/);
    assert.doesNotMatch(r.reason, new RegExp(GH), 'the secret value is never in the reason');
  });

  test('no secret value reaches the decision log, only the rule', () => {
    const w = world();
    // log on: evaluate writes ~sakk/decisions.jsonl; the value must never land there
    evaluate(
      normalize('claude-code', {
        hook_event_name: 'PreToolUse',
        cwd: w.base,
        ...writeEv(w, 'src/notes.txt', `token = "${GH}"\n`),
      }),
      { env: w.env, log: true },
    );
    const logPath = join(w.env.SAKK_HOME, 'decisions.jsonl');
    assert.ok(existsSync(logPath), 'a decision was logged');
    const logged = readFileSync(logPath, 'utf8');
    assert.match(logged, /"ruleId":"secret"/);
    assert.doesNotMatch(logged, new RegExp(GH), 'the secret value is never in the log');
  });

  test('a fiction token does not exempt a real secret beside it', () => {
    const w = world();
    // the declared fiction token is allowed alone, but a real secret beside it still denies
    assert.equal(
      run(w, writeEv(w, 'src/notes.txt', `x = "${FICTIONAL_EXEMPTION_TOKEN}"\n`)).verdict,
      'allow',
    );
    assert.equal(
      run(w, writeEv(w, 'src/notes.txt', `a="${FICTIONAL_EXEMPTION_TOKEN}"\nb="${GH}"\n`)).verdict,
      'deny',
    );
  });
});

/** Drive the real hook as any agent (the deny the agent would read). */
const runAs = (agent, w, payload) =>
  evaluate(normalize(agent, { cwd: w.base, ...payload }), { env: w.env, log: false });

describe('every write surface and agent is covered, and zero actions cannot smuggle a secret (F-160)', () => {
  test('a secret written through MultiEdit or NotebookEdit is denied, not only Write/Edit', () => {
    const w = world();
    const multi = {
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: join(w.base, 'src/a.js'),
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'x', new_string: `k=${GH}` },
        ],
      },
    };
    assert.equal(runAs('claude-code', w, multi).verdict, 'deny');
    const nb = {
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: join(w.base, 'n.ipynb'), new_source: `token=${AWS}` },
    };
    assert.equal(runAs('claude-code', w, nb).verdict, 'deny');
  });

  test('a codex apply_patch whose body adds a secret line is denied', () => {
    const w = world();
    const patch = {
      tool_name: 'apply_patch',
      tool_input: {
        command: `*** Begin Patch\n*** Update File: src/config.js\n@@\n+const key = "${GH}";\n*** End Patch\n`,
      },
    };
    assert.equal(runAs('codex', w, patch).verdict, 'deny');
  });

  test('a cursor Edit (not just cursor Write) whose new content is a secret is denied', () => {
    const w = world();
    const edit = {
      hook_event_name: 'preToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: join(w.base, 'src/a.js'), old_string: 'x', new_string: `k=${GH}` },
    };
    assert.equal(runAs('cursor', w, edit).verdict, 'deny');
    // control: a cursor Edit with ordinary content is allowed
    const ok = {
      hook_event_name: 'preToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: join(w.base, 'src/a.js'), old_string: 'x', new_string: 'y = 1' },
    };
    assert.equal(runAs('cursor', w, ok).verdict, 'allow');
  });

  test('a command that tokenizes to zero actions still cannot carry a secret', () => {
    const w = world();
    // a bare NAME=<secret> assignment and a comment-only command both classify
    // to no action; the call-level floor must still deny when a secret is present
    assert.equal(run(w, bashEv(w, `TOKEN=${GH}`)).verdict, 'deny');
    assert.equal(run(w, bashEv(w, `# deploy with ${AWS}`)).verdict, 'deny');
    // control: the same zero-action shapes without a secret are allowed
    assert.equal(run(w, bashEv(w, 'TOKEN=abc')).verdict, 'allow');
    assert.equal(run(w, bashEv(w, '# just a comment')).verdict, 'allow');
  });
});

describe('reading a protected secret file is denied (M3, protect-secret-files)', () => {
  test('K-FN-005 a cat of a secret file is denied; ordinary reads are allowed', () => {
    const w = world();
    // The protect-secret-files rule denies a read whose spelled-out path names a
    // secret — .env, an SSH private key, a $HOME/.env whose literal tail is `.env`.
    for (const cmd of ['cat .env', 'cat ~/.ssh/id_rsa', 'cat "$HOME/.env"']) {
      const r = run(w, bashEv(w, cmd));
      assert.equal(r.verdict, 'deny', `${cmd} should be denied`);
      assert.match(
        r.reason,
        /protect-secret-files|secret\.read/,
        `${cmd} denied by the secret-read rule`,
      );
    }
    // control: ordinary reads / listing are allowed
    assert.equal(run(w, bashEv(w, 'cat README.md')).verdict, 'allow');
    assert.equal(run(w, bashEv(w, 'ls -la && head package.json')).verdict, 'allow');
  });
});

describe('K-SEC-043 / K-SEC-045: the secret read guard judges the name a command spells out (documented boundary, F-173)', () => {
  // protect-secret-files matches the LITERAL argv token against the secret-name
  // pattern; the shell performs glob, brace and variable expansion only AFTER the
  // hook has classified the pre-expansion word. Decision D5 (2026-10-28) kept
  // that behaviour; F-176 (D11) narrows the allowed side: a word holding an
  // unresolved variable or brace expansion now makes the command constructed and
  // asked, so only run-time choices the shell makes from literal text (globs,
  // grep -r, find -exec, xargs) remain the documented allowed boundary. The
  // README limit "It reads a command as written" states the boundary; this test
  // pins BOTH sides so a change to either the guard or the README is deliberate.
  test('K-SEC-043/K-SEC-045 spelled-out secret reads are denied, constructed ones asked, run-time-picked names allowed', () => {
    const w = world();
    const at = (cmd) => run(w, bashEv(w, cmd));
    const deniedAsSecret = (cmd) => {
      const r = at(cmd);
      return r.verdict === 'deny' && /protect-secret-files|secret\.read/.test(r.reason || '');
    };
    // denied: the secret's name is written in the command, however it is quoted
    for (const cmd of [
      'cat .env',
      'cat ./.env',
      'cat src/../.env',
      'cat ".env"',
      "cat '.env'",
      'cat \\.env',
      'head -n1 .env',
      'cat $(echo .env)',
      'bash -c "cat .env"',
    ]) {
      assert.ok(deniedAsSecret(cmd), `${cmd} spells out .env and is denied`);
    }
    // asked: a command built at run time is never judged by what it does.
    // Since F-176 this includes variable and brace expansions the guard
    // cannot resolve statically.
    for (const cmd of [
      'cat `echo .env`',
      'eval "cat .env"',
      'bash -c "$X"',
      'source .env',
      'cat .e{nv,x}',
      'cat .e{nv,xample}',
      'f=.env; cat $f',
    ]) {
      assert.equal(at(cmd).verdict, 'require_approval', `${cmd} is constructed and is asked`);
    }
    // allowed — the boundary: the shell or a program picks the file at run time
    // from literal text the guard can read but not enumerate
    for (const cmd of [
      'cat .e*',
      'cat .en?',
      'cat .??*',
      'grep -r KEY .',
      'find . -name .env -exec cat {} \\;',
      'xargs cat < list.txt',
    ]) {
      assert.equal(
        at(cmd).verdict,
        'allow',
        `F-173 boundary: ${cmd} is judged by its written name`,
      );
    }
  });
});
