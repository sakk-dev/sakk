import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize, evaluate } from '../src/hook.mjs';
import { CLAUDE_MATCHER, CODEX_MATCHER, CURSOR_EVENTS } from '../src/guard-install.mjs';

/**
 * F-202 class detector (C-02: a partial list stands in for the rule): the
 * secret scan covers EVERY tool call the hook can receive and EVERY field
 * that carries content — not a hand-picked list of (tool, field) pairs. The
 * checklist below enumerates one case per tool × content-carrying field, the
 * matcher-coverage test ties the checklist to the installed matchers (the
 * source of which tools the hook receives), and the structural tests plant a
 * secret where no list would think to look (unknown tool, deep nesting,
 * arrays, object keys). Work is bounded by MAX_PAYLOAD, asserted by verdicts,
 * never a stopwatch.
 */
// real-shaped, not live: built by join so the repository scans clean
const GH = ['ghp', '_', 'a1'.repeat(20)].join('');

function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'scan-cov-')));
  mkdirSync(join(base, 'src'), { recursive: true });
  return { base, env: { ...process.env, SAKK_HOME: join(base, '.sakk'), HOME: base } };
}
const judge = (w, agent, payload) =>
  evaluate(normalize(agent, { cwd: w.base, ...payload }), { env: w.env, log: false });
const secretDeny = (r) => r.verdict === 'deny' && r.decisions.some((d) => d.ruleId === 'secret');
const noSecretDeny = (r) => r.decisions.every((d) => d.ruleId !== 'secret');

// One row per tool × content-carrying field. The third element plants a value
// in that field; the same payload with a benign value is the control.
const cc = (tool_name, tool_input) => ({
  hook_event_name: 'PreToolUse',
  tool_name,
  tool_input,
  session_id: 's-cov',
  tool_use_id: 'c-cov',
});
const cur = (hook_event_name, rest) => ({
  hook_event_name,
  conversation_id: 's-cov',
  generation_id: 'c-cov',
  ...rest,
});
const curTool = (tool_name, tool_input) => cur('preToolUse', { tool_name, tool_input });
const SURFACES = [
  // claude-code / codex shell tools: the command
  ['claude-code', 'Bash.command', (v) => cc('Bash', { command: `echo ${v}` })],
  ['claude-code', 'PowerShell.command', (v) => cc('PowerShell', { command: `echo ${v}` })],
  ['claude-code', 'Monitor.command', (v) => cc('Monitor', { command: `echo ${v}` })],
  ['codex', 'Bash.command', (v) => cc('Bash', { command: `echo ${v}` })],
  // codex patches: every input spelling
  ['codex', 'apply_patch.command', (v) => cc('apply_patch', { command: `*** patch ${v}` })],
  ['codex', 'apply_patch.patch', (v) => cc('apply_patch', { patch: `*** patch ${v}` })],
  ['codex', 'apply_patch.input', (v) => cc('apply_patch', { input: `*** patch ${v}` })],
  // write tools: the new bytes, the old bytes, and the path
  ['claude-code', 'Write.content', (v) => cc('Write', { file_path: 'src/a.js', content: v })],
  [
    'claude-code',
    'Write.file_path',
    (v) => cc('Write', { file_path: `src/${v}.js`, content: 'x' }),
  ],
  [
    'claude-code',
    'Edit.new_string',
    (v) => cc('Edit', { file_path: 'src/a.js', old_string: 'x', new_string: v }),
  ],
  [
    'claude-code',
    'Edit.old_string',
    (v) => cc('Edit', { file_path: 'src/a.js', old_string: v, new_string: 'x' }),
  ],
  [
    'claude-code',
    'MultiEdit.edits.new_string',
    (v) => cc('MultiEdit', { file_path: 'src/a.js', edits: [{ old_string: 'x', new_string: v }] }),
  ],
  [
    'claude-code',
    'MultiEdit.edits.old_string',
    (v) => cc('MultiEdit', { file_path: 'src/a.js', edits: [{ old_string: v, new_string: 'x' }] }),
  ],
  [
    'claude-code',
    'NotebookEdit.new_source',
    (v) => cc('NotebookEdit', { notebook_path: 'src/n.ipynb', new_source: v }),
  ],
  // read/search tools: the path and the pattern are payload content too
  ['claude-code', 'Read.file_path', (v) => cc('Read', { file_path: `src/${v}` })],
  ['claude-code', 'Grep.pattern', (v) => cc('Grep', { pattern: v, path: 'src' })],
  ['claude-code', 'Glob.pattern', (v) => cc('Glob', { pattern: `**/${v}` })],
  // MCP tools: arguments of any shape
  ['claude-code', 'mcp__srv__send.param', (v) => cc('mcp__srv__send', { body: v })],
  ['claude-code', 'mcp__srv__send.nested', (v) => cc('mcp__srv__send', { a: { b: [{ c: v }] } })],
  ['codex', 'mcp__srv__send.param', (v) => cc('mcp__srv__send', { body: v })],
  // a tool the hook has no branch for at all
  ['claude-code', 'SomeFutureTool.param', (v) => cc('SomeFutureTool', { anything: v })],
  // cursor: every event, every content-carrying field
  [
    'cursor',
    'beforeShellExecution.command',
    (v) => cur('beforeShellExecution', { command: `echo ${v}` }),
  ],
  ['cursor', 'beforeReadFile.file_path', (v) => cur('beforeReadFile', { file_path: `src/${v}` })],
  [
    'cursor',
    'beforeMCPExecution.tool_input',
    (v) =>
      cur('beforeMCPExecution', {
        mcp_server_name: 'srv',
        tool_name: 'send',
        tool_input: { body: v },
      }),
  ],
  ['cursor', 'Shell.command', (v) => curTool('Shell', { command: `echo ${v}` })],
  ['cursor', 'Read.file_path', (v) => curTool('Read', { file_path: `src/${v}` })],
  ['cursor', 'Write.content', (v) => curTool('Write', { file_path: 'src/a.js', content: v })],
  [
    'cursor',
    'Write.file_path',
    (v) => curTool('Write', { file_path: `src/${v}.js`, content: 'x' }),
  ],
  [
    'cursor',
    'Edit.new_string',
    (v) => curTool('Edit', { file_path: 'src/a.js', old_string: 'x', new_string: v }),
  ],
  [
    'cursor',
    'MultiEdit.edits.new_string',
    (v) =>
      curTool('MultiEdit', { file_path: 'src/a.js', edits: [{ old_string: 'x', new_string: v }] }),
  ],
  [
    'cursor',
    'NotebookEdit.new_source',
    (v) => curTool('NotebookEdit', { notebook_path: 'src/n.ipynb', new_source: v }),
  ],
  ['cursor', 'Delete.file_path', (v) => curTool('Delete', { file_path: `src/${v}` })],
  ['cursor', 'MCP:srv.param', (v) => curTool('MCP:srv.send', { body: v })],
];

describe('F-202: the secret scan covers every tool and every content-carrying field', () => {
  test('every tool and every payload field the hook can receive passes the same secret scan', () => {
    const w = world();
    for (const [agent, name, p] of SURFACES) {
      const planted = judge(w, agent, p(GH));
      assert.ok(
        secretDeny(planted),
        `${agent} ${name}: a planted secret must deny (ruleId secret)`,
      );
      const control = judge(w, agent, p('benign-value'));
      assert.ok(noSecretDeny(control), `${agent} ${name}: the control must not trip the scan`);
    }
  });

  test('the checklist covers every tool the installed matchers deliver (enumerated from the source)', () => {
    const covered = (agent, tok) =>
      SURFACES.some(
        ([a, name]) =>
          a === agent &&
          (tok === 'mcp__.*' ? name.startsWith('mcp__') : name.startsWith(`${tok}.`)),
      );
    for (const tok of CLAUDE_MATCHER.split('|'))
      assert.ok(covered('claude-code', tok), `claude-code matcher token ${tok} has no scan case`);
    for (const tok of CODEX_MATCHER.split('|'))
      assert.ok(covered('codex', tok), `codex matcher token ${tok} has no scan case`);
    for (const [event, matcher] of Object.entries(CURSOR_EVENTS)) {
      if (matcher === null)
        assert.ok(
          SURFACES.some(([a, name]) => a === 'cursor' && name.startsWith(`${event}.`)),
          `cursor event ${event} has no scan case`,
        );
      else
        for (const tok of matcher.split('|'))
          assert.ok(
            SURFACES.some(([a, name]) => a === 'cursor' && name.startsWith(`${tok}.`)),
            `cursor ${event} tool ${tok} has no scan case`,
          );
    }
  });

  test('a secret anywhere in the payload is found: unknown fields, deep nesting, arrays, object keys', () => {
    const w = world();
    let deep = GH;
    for (let i = 0; i < 60; i++) deep = i % 2 ? { nest: deep } : [deep];
    const shapes = [
      cc('mcp__srv__send', { [GH]: 'an object key carries it' }),
      cc('mcp__srv__send', { args: deep }),
      cc('SomeFutureTool', { a: [{ b: { c: [GH] } }] }),
      cc('Bash', { command: 'echo ok', description: `note ${GH}` }),
    ];
    for (const p of shapes)
      assert.ok(
        secretDeny(judge(w, 'claude-code', p)),
        `planted in ${JSON.stringify(Object.keys(p.tool_input))}`,
      );
    // control: the same shapes without the secret never trip the scan
    const benign = cc('mcp__srv__send', { args: { a: [{ b: 'ordinary text' }] } });
    assert.ok(noSecretDeny(judge(w, 'claude-code', benign)));
  });
});
