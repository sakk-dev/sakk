// SPDX-License-Identifier: AGPL-3.0-only
//
// `sakk guard install|uninstall <agent>` and `sakk doctor` (specs/guard/spec.md,
// "Install" and "Doctor"). Install merges into the agent's own hook config and
// never replaces it; uninstall removes only what install added. The doctor
// checks that the hook would really fire, not only that it is configured
// (F-132: a hook can be configured and never run).

import { execFileSync, spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy } from './policy.mjs';
import { AGENTS, SHIPPED_POLICY, repoRootOf, sakkHome } from './hook.mjs';

export const BIN = realpathSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sakk.mjs'),
);
const q = (s) => `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
/** The installed command line: absolute node and sakk, so PATH at hook time does not matter. */
export const hookCommand = (agent, node = process.execPath) =>
  `${q(node)} ${q(BIN)} hook --agent ${agent}`;
/** Ours: the command names this kind of hook, whichever installation wrote it. */
const ours = (cmd, agent) =>
  typeof cmd === 'string' && cmd.includes('sakk.mjs') && cmd.includes(`hook --agent ${agent}`);

export const CLAUDE_MATCHER =
  'Bash|PowerShell|Monitor|Read|Edit|Write|MultiEdit|NotebookEdit|mcp__.*';
export const CURSOR_EVENTS = Object.freeze({
  preToolUse: 'Write|Delete', // edits; shell, reads and MCP have their own events below
  beforeShellExecution: null,
  beforeReadFile: null,
  beforeMCPExecution: null,
});
export const CODEX_MATCHER = 'Bash|apply_patch|mcp__.*';

/** Where each agent reads hooks: the project (repository top) or the user's home. */
export function configPath(agent, { user = false, cwd = process.cwd(), home = homedir() } = {}) {
  const base = user ? home : (repoRootOf(cwd) ?? cwd);
  if (agent === 'claude-code') return join(base, '.claude', 'settings.json');
  if (agent === 'cursor') return join(base, '.cursor', 'hooks.json');
  if (agent === 'codex') return join(base, '.codex', 'hooks.json');
  throw new Error(`unknown agent ${agent}`);
}

/** Claude Code supports onFailure: "block" from 2.1.295; older versions would not know the key. */
export function claudeSupportsOnFailure(
  run = () =>
    execFileSync('claude', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
) {
  try {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(run());
    if (!m) return false;
    const [a, b, c] = m.slice(1).map(Number);
    return a > 2 || (a === 2 && (b > 1 || (b === 1 && c >= 295)));
  } catch {
    return false;
  }
}

const readJson = (p) => {
  if (!existsSync(p)) return {};
  const raw = readFileSync(p, 'utf8');
  if (raw.trim() === '') return {};
  try {
    const v = JSON.parse(raw);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch (e) {
    const err = new Error(
      `GUARD_CONFIG_UNREADABLE: ${p} is not a JSON object (${e.message}) — fix it by hand; nothing was changed`,
    );
    err.code = 'GUARD_CONFIG_UNREADABLE';
    throw err;
  }
};

/** The config with the guard added (pure). */
export function withGuard(agent, cfg, { command, onFailure = false }) {
  const c = structuredClone(cfg);
  if (agent === 'claude-code' || agent === 'codex') {
    c.hooks ??= {};
    c.hooks.PreToolUse ??= [];
    const present = c.hooks.PreToolUse.some((g) =>
      (g.hooks ?? []).some((h) => ours(h.command, agent)),
    );
    if (!present) {
      const hook = {
        type: 'command',
        command,
        timeout: 10,
        ...(onFailure ? { onFailure: 'block' } : {}),
      };
      c.hooks.PreToolUse.push({
        matcher: agent === 'codex' ? CODEX_MATCHER : CLAUDE_MATCHER,
        hooks: [hook],
      });
    }
    return c;
  }
  c.version ??= 1;
  c.hooks ??= {};
  for (const [event, matcher] of Object.entries(CURSOR_EVENTS)) {
    c.hooks[event] ??= [];
    if (!c.hooks[event].some((h) => ours(h.command, agent)))
      c.hooks[event].push({
        command,
        timeout: 10,
        failClosed: true,
        ...(matcher ? { matcher } : {}),
      });
  }
  return c;
}

/** The config with only the guard's own entries removed (pure). */
export function withoutGuard(agent, cfg) {
  const c = structuredClone(cfg);
  if (!c.hooks) return c;
  if (agent === 'claude-code' || agent === 'codex') {
    c.hooks.PreToolUse = (c.hooks.PreToolUse ?? [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !ours(h.command, agent)) }))
      .filter((g) => g.hooks.length > 0);
    if (c.hooks.PreToolUse.length === 0) delete c.hooks.PreToolUse;
  } else
    for (const event of Object.keys(CURSOR_EVENTS)) {
      if (!c.hooks[event]) continue;
      c.hooks[event] = c.hooks[event].filter((h) => !ours(h.command, agent));
      if (c.hooks[event].length === 0) delete c.hooks[event];
    }
  if (Object.keys(c.hooks).length === 0) delete c.hooks;
  return c;
}

function writeConfig(path, before, after) {
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (!changed) return { path, changed: false };
  mkdirSync(dirname(path), { recursive: true });
  let backup = null;
  if (existsSync(path)) {
    backup = `${path}.sakk-backup`;
    copyFileSync(path, backup);
  }
  writeFileSync(path, `${JSON.stringify(after, null, 2)}\n`);
  return { path, changed: true, backup };
}

export function install(agent, opts = {}) {
  if (!AGENTS.includes(agent))
    throw new Error(`GUARD_USAGE: agent must be one of ${AGENTS.join(', ')}`);
  const path = configPath(agent, opts);
  const before = readJson(path);
  const onFailure =
    agent === 'claude-code' && (opts.supportsOnFailure ?? claudeSupportsOnFailure());
  const after = withGuard(agent, before, {
    command: opts.command ?? hookCommand(agent),
    onFailure,
  });
  return { ...writeConfig(path, before, after), onFailure };
}

export function uninstall(agent, opts = {}) {
  if (!AGENTS.includes(agent))
    throw new Error(`GUARD_USAGE: agent must be one of ${AGENTS.join(', ')}`);
  const path = configPath(agent, opts);
  if (!existsSync(path)) return { path, changed: false };
  const before = readJson(path);
  return writeConfig(path, before, withoutGuard(agent, before));
}

/** The installed guard hook objects of one config file, for one agent (ours only). */
function installedHooks(agent, path) {
  if (!existsSync(path)) return [];
  let cfg;
  try {
    cfg = readJson(path);
  } catch {
    return [];
  }
  const all =
    agent === 'cursor'
      ? Object.values(cfg.hooks ?? {}).flat()
      : (cfg.hooks?.PreToolUse ?? []).flatMap((g) => g.hooks ?? []);
  return all.filter((h) => ours(h.command, agent));
}

/** The installed guard commands of one config file, for one agent. */
function installedCommands(agent, path) {
  return installedHooks(agent, path).map((h) => h.command);
}

/** A synthetic forced push in each agent's shape: the installed hook must deny it. */
export function firePayload(agent, cwd) {
  const command = 'git push --force origin main';
  if (agent === 'cursor')
    return {
      hook_event_name: 'beforeShellExecution',
      command,
      cwd,
      conversation_id: 'doctor',
      generation_id: 'doctor',
    };
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    cwd,
    session_id: 'doctor',
    tool_use_id: 'doctor-fire',
  };
}
const denied = (agent, out) =>
  agent === 'cursor' ? /"permission":"deny"/.test(out) : /"permissionDecision":"deny"/.test(out);

/** Run one installed command line as the agent would: payload on stdin, answer on stdout. */
export function fire(agent, command, cwd, env = process.env) {
  const r = spawnSync('/bin/sh', ['-c', command], {
    input: JSON.stringify(firePayload(agent, cwd)),
    encoding: 'utf8',
    cwd,
    env: { ...env, SAKK_DOCTOR: '1' },
    timeout: 15_000,
  });
  return {
    ok: r.status === 0 && denied(agent, r.stdout ?? ''),
    stdout: r.stdout ?? '',
    status: r.status,
  };
}

/**
 * Every check prints one line; any failed check fails the doctor (exit 1).
 * Returns [{ name, ok, detail, warn? }].
 */
export function doctor({
  cwd = process.cwd(),
  home = homedir(),
  env = process.env,
  managed = '/Library/Application Support/ClaudeCode/managed-settings.json',
  // probe:false reports the installed state without firing the hook or creating
  // Sakk's home — a read-only, subprocess-free check for `sakk ui` (M4 review).
  probe = true,
} = {}) {
  const out = [];
  const add = (name, ok, detail, warn = false) => out.push({ name, ok, detail, warn });
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 20, `Node ${process.versions.node} (20 or later required)`);
  const root = repoRootOf(cwd);
  const local = root ? join(root, '.sakk', 'policy.json') : null;
  const policyPath = local && existsSync(local) ? local : SHIPPED_POLICY;
  try {
    const { policy, policyHash } = loadPolicy({ policyPath });
    add(
      'policy',
      true,
      `${policyPath} — ${policy.rules.length} rules, sha256 ${policyHash.slice(0, 12)}…`,
    );
  } catch (e) {
    add('policy', false, `${policyPath}: ${e.message}`);
  }
  const sh = sakkHome(env);
  try {
    if (probe) mkdirSync(sh, { recursive: true }); // read-only check never creates it
    accessSync(sh, constants.W_OK);
    add('decision log', true, `${join(sh, 'decisions.jsonl')} is writable`);
  } catch (e) {
    if (!probe && e.code === 'ENOENT')
      add('decision log', true, `${sh} will be created on the first call`, true);
    else
      add(
        'decision log',
        false,
        `${sh} is not writable (${e.code ?? e.message}) — every call would be denied`,
      );
  }
  let anyInstalled = false;
  for (const agent of AGENTS) {
    const places = [
      ['project', configPath(agent, { cwd, home })],
      ['user', configPath(agent, { user: true, cwd, home })],
    ];
    const found = places.flatMap(([where, p]) =>
      installedCommands(agent, p).map((c) => ({ where, p, c })),
    );
    if (agent === 'claude-code' && existsSync(managed))
      for (const c of installedCommands(agent, managed))
        found.push({ where: 'managed', p: managed, c });
    if (found.length === 0) {
      add(`${agent}`, true, 'not installed (sakk guard install ' + agent + ' to add it)', true);
      continue;
    }
    anyInstalled = true;
    for (const f of found) {
      if (!probe) {
        // read-only: report that the hook is installed, without running it
        add(`${agent} (${f.where})`, true, `${f.p}: installed (run sakk doctor to probe it fires)`);
        continue;
      }
      const r = fire(agent, f.c, root ?? cwd, env);
      add(
        `${agent} (${f.where})`,
        r.ok,
        r.ok
          ? `${f.p}: a forced push is denied`
          : `${f.p}: the installed hook did not deny a forced push (exit ${r.status}) — reinstall with sakk guard install ${agent}`,
      );
    }
    if (agent === 'claude-code' && found.every((f) => f.where === 'project'))
      add(
        'claude-code start folder',
        true,
        `Claude Code loads ${found[0].p} only for sessions started in ${dirname(dirname(found[0].p))}; a session started in a parent folder skips it — add --user, or managed settings, if you start sessions elsewhere`,
        true,
      );
  }
  const claudeProject =
    installedCommands('claude-code', configPath('claude-code', { cwd, home })).length > 0;
  const cursorAny =
    installedCommands('cursor', configPath('cursor', { cwd, home })).length > 0 ||
    installedCommands('cursor', configPath('cursor', { user: true, cwd, home })).length > 0;
  if (claudeProject && cursorAny)
    add(
      'cursor double run',
      true,
      'Cursor also runs Claude Code project hooks, so each Cursor call is decided twice; harmless, but logged twice',
      true,
    );
  // A fail-open install is a degraded guard, not a healthy one: a Claude Code
  // hook with no onFailure: block was installed on a binary older than 2.1.295,
  // so if the hook process ever fails to start the tool call proceeds UNGUARDED.
  // Surface it here — the one tool install points the operator at — rather than
  // leave the lost guarantee to be inferred from an absent config key (F-174).
  const claudeHooks = [
    configPath('claude-code', { cwd, home }),
    configPath('claude-code', { user: true, cwd, home }),
    ...(existsSync(managed) ? [managed] : []),
  ].flatMap((p) => installedHooks('claude-code', p));
  if (claudeHooks.length > 0 && claudeHooks.some((h) => h.onFailure !== 'block'))
    add(
      'claude-code fail-open',
      true,
      'the installed Claude Code hook has no onFailure: block — it was installed on a Claude Code older than 2.1.295, so if the hook ever fails to start the tool call proceeds UNGUARDED; upgrade Claude Code and run sakk guard install claude-code again for a fail-closed guard',
      true,
    );
  if (!anyInstalled)
    add(
      'installed',
      false,
      'no agent has the guard installed — run: sakk guard install claude-code',
    );
  return out;
}
