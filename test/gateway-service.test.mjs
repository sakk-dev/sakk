/**
 * The service templates in integrations/litellm/service/ keep the Sakk gateway
 * running: launchd restarts it (KeepAlive), systemd restarts it
 * (Restart=always), both bind 127.0.0.1 only, and both set every variable
 * sakk_gateway.py requires and none it does not read. The variable names come
 * from the plugin's own source, so a variable added there is checked here.
 * Nothing is loaded into launchd or systemd: these read the committed files an
 * operator copies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LITELLM = join(ROOT, 'integrations', 'litellm');
const SERVICE = join(LITELLM, 'service');
const PLIST_FILE = 'io.github.sakk-dev.gateway.plist';
const UNIT_FILE = 'sakk-gateway.service';
const read = (...p) => readFileSync(join(...p), 'utf8');

const PLIST = read(SERVICE, PLIST_FILE);
const UNIT = read(SERVICE, UNIT_FILE);
const README = read(SERVICE, 'README.md');
const PLUGIN = read(LITELLM, 'sakk_gateway.py');

/** The SAKK_* names the plugin reads, and the ones it refuses to start without. */
function pluginVars(src) {
  const names = (re) => new Set([...src.matchAll(re)].map((m) => m[1]));
  const required = names(/_required_env\(\s*"(SAKK_[A-Z_]+)"/g);
  const reads = names(/(?:_required_env|os\.environ\.get)\(\s*"(SAKK_[A-Z_]+)"/g);
  return { required, reads };
}
const VARS = pluginVars(PLUGIN);

// ---------------------------------------------------------------- plist reader

const SCALAR = new Set(['string', 'key', 'integer', 'real', 'date', 'data']);
const ELEMENTS = new Set([...SCALAR, 'dict', 'array', 'true', 'false']);
const DECL = /^<\?xml version="1\.0" encoding="UTF-8"\?>/;
const TEXT = /^(?:[^&]|&(?:amp|lt|gt|quot|apos);)*$/;
const TAG = /^<(\/?)([a-z]+)(\s+version="1\.0")?\s*(\/?)>$/;

/**
 * A strict XML property list reader: the declaration, an optional plist
 * DOCTYPE and comments, then <plist version="1.0"> around one dict. Only the
 * plist element types, matched close tags and escaped text are accepted.
 * Throws on anything else.
 */
function parsePlist(xml) {
  if (!DECL.test(xml)) throw new Error('no XML declaration');
  let body = xml.replace(/^<\?xml[^>]*\?>/, '');
  body = body.replace(/<!--[\s\S]*?-->/g, '');
  body = body.replace(/<!DOCTYPE plist PUBLIC "[^"]*" "[^"]*">/, '');
  const toks = [];
  for (const [t] of body.matchAll(/<[^>]*>|[^<]+/g)) {
    if (t[0] !== '<') {
      if (!TEXT.test(t)) throw new Error(`unescaped text ${JSON.stringify(t)}`);
      if (t.trim()) toks.push({ text: t });
      continue;
    }
    const m = t.match(TAG);
    if (!m) throw new Error(`malformed tag ${t}`);
    const [, close, name, version, self] = m;
    const known = name === 'plist' || ELEMENTS.has(name);
    if (!known) throw new Error(`unknown element <${name}>`);
    if (version && name !== 'plist') throw new Error(`attribute on <${name}>`);
    toks.push({ name, close: !!close, self: !!self, version: !!version });
  }
  let i = 0;
  const take = () => {
    if (i >= toks.length) throw new Error('the plist ends early');
    return toks[i++];
  };
  const closeOf = (name) => {
    const t = take();
    if (!t.close || t.name !== name) throw new Error(`<${name}> is not closed`);
  };
  const isClose = (name) => toks[i] && toks[i].close && toks[i].name === name;
  function value() {
    const t = take();
    if (t.text !== undefined || t.close) throw new Error('expected a value');
    if (t.name === 'true' || t.name === 'false') {
      if (!t.self) throw new Error(`<${t.name}> must be empty`);
      return t.name === 'true';
    }
    if (t.name === 'dict' || t.name === 'array') {
      if (t.self) return t.name === 'dict' ? {} : [];
      if (t.name === 'array') {
        const out = [];
        while (!isClose('array')) out.push(value());
        closeOf('array');
        return out;
      }
      const out = {};
      while (!isClose('dict')) {
        const k = take();
        if (k.name !== 'key' || k.close || k.self) throw new Error('a dict entry without <key>');
        const name = toks[i]?.text ?? '';
        if (name) i++;
        closeOf('key');
        if (Object.hasOwn(out, name)) throw new Error(`key ${name} twice`);
        out[name] = value();
      }
      closeOf('dict');
      return out;
    }
    if (!SCALAR.has(t.name) || t.name === 'key') throw new Error(`<${t.name}> is not a value`);
    if (t.self) return '';
    const text = toks[i]?.text ?? '';
    if (text) i++;
    closeOf(t.name);
    if (t.name === 'integer') {
      if (!/^-?\d+$/.test(text.trim())) throw new Error(`integer ${text}`);
      return Number(text);
    }
    return text;
  }
  const root = take();
  const notRoot = root.name !== 'plist' || root.close || !root.version;
  if (notRoot) throw new Error('no <plist version="1.0"> root');
  const top = value();
  closeOf('plist');
  if (i !== toks.length) throw new Error('content after </plist>');
  if (typeof top !== 'object' || Array.isArray(top)) throw new Error('the root is not a dict');
  return top;
}

// ---------------------------------------------------------------- checks

/** What is wrong with a set of variable names against the plugin's own. */
function envProblems(names, label, vars = VARS) {
  const out = [];
  const missing = [...vars.required].filter((n) => !names.includes(n));
  for (const n of missing) out.push(`${label} does not set ${n}, which the plugin requires`);
  const unread = names.filter((n) => n.startsWith('SAKK_') && !vars.reads.has(n));
  for (const n of unread) out.push(`${label} sets ${n}, which the plugin does not read`);
  return out;
}

/** The host after --host in an argument list; a missing --host is a problem too. */
function hostProblems(args, label) {
  const at = args.indexOf('--host');
  if (at < 0) return [`${label} has no --host, so LiteLLM binds every interface`];
  const host = args[at + 1];
  return host === '127.0.0.1' ? [] : [`${label} binds ${host}, not 127.0.0.1`];
}

function plistProblems(xml) {
  let p;
  try {
    p = parsePlist(xml);
  } catch (e) {
    return [`malformed plist: ${e.message}`];
  }
  const out = [];
  if (typeof p.Label !== 'string' || !p.Label) out.push('no Label');
  if (p.KeepAlive !== true) out.push('KeepAlive is not true');
  if (p.RunAtLoad !== true) out.push('RunAtLoad is not true');
  const throttled = Number.isInteger(p.ThrottleInterval) && p.ThrottleInterval >= 5;
  if (!throttled) out.push('ThrottleInterval is not at least 5 seconds');
  for (const k of ['StandardOutPath', 'StandardErrorPath']) {
    if (typeof p[k] !== 'string' || !p[k]) out.push(`no ${k}`);
  }
  const args = Array.isArray(p.ProgramArguments) ? p.ProgramArguments : [];
  if (!args.length) out.push('no ProgramArguments');
  out.push(...hostProblems(args, 'the plist'));
  out.push(...envProblems(Object.keys(p.EnvironmentVariables ?? {}), 'the plist'));
  return out;
}

/** [section, key, value] for every assignment in a systemd unit. */
function unitEntries(text) {
  const out = [];
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const s = line.match(/^\[([A-Za-z]+)\]$/);
    if (s) {
      section = s[1];
      continue;
    }
    const kv = line.match(/^([A-Za-z]+)=(.*)$/);
    if (!kv) throw new Error(`unreadable unit line ${line}`);
    out.push([section, kv[1], kv[2]]);
  }
  return out;
}

/** The variable names a unit's Environment= lines set. */
function unitVars(text) {
  const env = unitEntries(text).filter(([s, k]) => s === 'Service' && k === 'Environment');
  return env.map(([, , v]) => v.split('=')[0]);
}

function unitProblems(text) {
  let entries;
  try {
    entries = unitEntries(text);
  } catch (e) {
    return [e.message];
  }
  const get = (sec, key) => {
    return entries.filter(([s, k]) => s === sec && k === key).map((e) => e[2]);
  };
  const out = [];
  if (get('Service', 'Restart').join() !== 'always') out.push('Restart is not always');
  const sec = get('Service', 'RestartSec');
  const spaced = sec.length === 1 && /^\d+$/.test(sec[0]) && Number(sec[0]) >= 5;
  if (!spaced) out.push('RestartSec is not at least 5 seconds');
  const wanted = get('Install', 'WantedBy').join();
  if (wanted !== 'default.target') out.push('not WantedBy=default.target');
  const envFile = get('Service', 'EnvironmentFile');
  if (envFile.length !== 1) out.push('no EnvironmentFile for the keys');
  const exec = get('Service', 'ExecStart');
  if (exec.length !== 1) out.push('not exactly one ExecStart');
  out.push(...hostProblems((exec[0] ?? '').split(/\s+/), 'the unit'));
  out.push(...envProblems(unitVars(text), 'the unit'));
  return out;
}

const placeholders = (text) => [...new Set(text.match(/__[A-Z][A-Z_]*[A-Z]__/g) ?? [])].sort();

/** The README text from a ## heading up to the next ## heading. */
function section(md, heading) {
  const at = md.indexOf(`\n## ${heading}`);
  if (at < 0) return '';
  const end = md.indexOf('\n## ', at + 1);
  return md.slice(at, end < 0 ? undefined : end);
}

// ---------------------------------------------------------------- tests

test('the launchd plist is well formed, keeps the gateway alive and binds 127.0.0.1', () => {
  assert.deepEqual(plistProblems(PLIST), []);
  const p = parsePlist(PLIST);
  assert.equal(p.Label, 'io.github.sakk-dev.gateway');
  assert.equal(`${p.Label}.plist`, PLIST_FILE, 'the file is named after its Label');
  const args = p.ProgramArguments.slice(1).join(' ');
  assert.equal(args, '--config __SAKK_GATEWAY_CONFIG__ --host 127.0.0.1 --port 4000');
  const env = p.EnvironmentVariables;
  assert.equal(env.SAKK_GATEWAY_CONFIG, '__SAKK_GATEWAY_CONFIG__', 'one config for both');
});

test('the systemd user unit restarts always and binds 127.0.0.1', () => {
  assert.deepEqual(unitProblems(UNIT), []);
  const exec = unitEntries(UNIT).find(([, k]) => k === 'ExecStart')[2];
  const want = '__LITELLM__ --config __SAKK_GATEWAY_CONFIG__ --host 127.0.0.1 --port 4000';
  assert.equal(exec, want);
  assert.match(UNIT, /^Environment=SAKK_GATEWAY_CONFIG=__SAKK_GATEWAY_CONFIG__$/m);
});

test('both service files set every variable the plugin requires and none it does not read', () => {
  // the plugin's own list: if this reads empty the pattern no longer matches it
  assert.ok(VARS.required.size >= 3, `sakk_gateway.py requires ${[...VARS.required]}`);
  for (const n of VARS.required) assert.ok(VARS.reads.has(n));
  const plistEnv = Object.keys(parsePlist(PLIST).EnvironmentVariables);
  const unitEnv = unitVars(UNIT);
  assert.deepEqual(envProblems(plistEnv, 'the plist'), []);
  assert.deepEqual(envProblems(unitEnv, 'the unit'), []);
  // node is named by path: launchd's PATH has no node
  assert.ok(plistEnv.includes('SAKK_NODE') && unitEnv.includes('SAKK_NODE'));
  // the same Sakk variables in both, so the two managers run the same gateway
  const sakk = (names) => names.filter((n) => n.startsWith('SAKK_')).sort();
  assert.deepEqual(sakk(plistEnv), sakk(unitEnv));
});

test('a malformed plist, a dropped KeepAlive or Restart, a missing variable or a public bind is refused (controls)', () => {
  const plist = (from, to, re) => {
    assert.ok(PLIST.includes(from), `control anchor ${from}`);
    assert.match(plistProblems(PLIST.replace(from, to)).join('; '), re);
  };
  const unit = (from, to, re) => {
    assert.ok(UNIT.includes(from), `control anchor ${from}`);
    assert.match(unitProblems(UNIT.replace(from, to)).join('; '), re);
  };
  const cut = PLIST.slice(0, PLIST.lastIndexOf('</dict>'));
  assert.match(plistProblems(cut).join(), /malformed plist: .*ends early/);
  plist('<key>RunAtLoad</key>', '<foo/><key>RunAtLoad</key>', /unknown element <foo>/);
  plist('<string>True</string>', '<string>True</strin>', /malformed plist/);
  plist('<string>True</string>', '<string>a & b</string>', /malformed plist: unescaped text/);
  const KEEP = '<key>KeepAlive</key>\n  <true/>';
  plist(KEEP, KEEP.replace('true', 'false'), /KeepAlive is not true/);
  plist(KEEP, '', /KeepAlive is not true/);
  plist('<integer>10</integer>', '<integer>0</integer>', /ThrottleInterval is not at least 5/);
  const LEDGER = '<key>SAKK_LEDGER</key>\n    <string>__SAKK_LEDGER__</string>';
  plist(LEDGER, '', /the plist does not set SAKK_LEDGER/);
  plist('<key>SAKK_NODE</key>', '<key>SAKK_NODES</key>', /the plist sets SAKK_NODES, which/);
  const HOST = '<string>127.0.0.1</string>';
  plist(HOST, HOST.replace('127.0.0.1', '0.0.0.0'), /the plist binds 0\.0\.0\.0,/);
  plist('<string>--host</string>', '<string>--hostname</string>', /the plist has no --host/);
  unit('Restart=always', 'Restart=on-failure', /Restart is not always/);
  unit('Restart=always\n', '', /Restart is not always/);
  unit('RestartSec=5', 'RestartSec=0', /RestartSec is not at least 5/);
  unit('--host 127.0.0.1', '--host 0.0.0.0', /the unit binds 0\.0\.0\.0,/);
  unit('Environment=SAKK_BIN=__SAKK_BIN__\n', '', /the unit does not set SAKK_BIN/);
  unit('EnvironmentFile=', '#EnvironmentFile=', /no EnvironmentFile/);
  unit('[Install]', '[Install]\nnot a setting', /unreadable unit line/);
  // a variable the plugin starts to require is missed by both files
  const add = (set) => new Set([...set, 'SAKK_NEW']);
  const more = { required: add(VARS.required), reads: add(VARS.reads) };
  const plistEnv = Object.keys(parsePlist(PLIST).EnvironmentVariables);
  assert.match(envProblems(plistEnv, 'the plist', more).join(), /SAKK_NEW/);
  assert.match(envProblems(unitVars(UNIT), 'the unit', more).join(), /SAKK_NEW/);
});

test('the service README fills every placeholder and names install, check and uninstall for both managers', () => {
  const mac = section(README, 'macOS (launchd)');
  const linux = section(README, 'Linux (systemd user service)');
  assert.ok(mac && linux, 'the README has a macOS and a Linux section');
  const pairs = { [PLIST_FILE]: [PLIST, mac], [UNIT_FILE]: [UNIT, linux] };
  for (const [file, [text, part]] of Object.entries(pairs)) {
    const want = placeholders(text);
    assert.ok(want.length > 0, `${file} has placeholders`);
    const unfilled = want.filter((p) => !part.includes(`-e "s|${p}|`));
    assert.deepEqual(unfilled, [], `${file}: the README's sed does not fill these`);
    assert.ok(part.includes(`service/${file}`), `the README's sed reads service/${file}`);
    const extra = placeholders(part).filter((p) => !want.includes(p));
    assert.deepEqual(extra, [], `the README fills placeholders ${file} does not have`);
  }
  // the table explains exactly the placeholders the templates use
  const named = placeholders(section(README, 'Placeholders'));
  assert.deepEqual(named, placeholders(PLIST + UNIT));
  const label = parsePlist(PLIST).Label;
  const dest = `~/Library/LaunchAgents/${PLIST_FILE}`;
  const macCmds = [
    `launchctl bootstrap gui/$UID ${dest}`,
    `launchctl print gui/$UID/${label}`,
    `launchctl kickstart -k gui/$UID/${label}`,
    `launchctl bootout gui/$UID ${dest}`,
    `chmod 600 ${dest}`,
  ];
  for (const cmd of macCmds) assert.ok(mac.includes(cmd), `macOS section lacks ${cmd}`);
  const linCmds = [
    `systemctl --user enable --now ${UNIT_FILE}`,
    `systemctl --user status ${UNIT_FILE}`,
    `systemctl --user disable --now ${UNIT_FILE}`,
    `journalctl --user -u ${UNIT_FILE}`,
    'loginctl enable-linger "$USER"',
    'install -m 600 /dev/null ~/.config/sakk-gateway/secrets.env',
  ];
  for (const cmd of linCmds) assert.ok(linux.includes(cmd), `Linux section lacks ${cmd}`);
  // the secrets file the unit reads is the one the README creates
  assert.match(UNIT, /^EnvironmentFile=%h\/\.config\/sakk-gateway\/secrets\.env$/m);
  // the health URL is the one the plugin's own tests wait on
  const health = 'http://127.0.0.1:4000/health/liveliness';
  assert.ok(mac.includes(health) && linux.includes(health));
  assert.ok(read(LITELLM, 'test_sakk_gateway.py').includes('/health/liveliness'));
});
