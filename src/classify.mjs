// SPDX-License-Identifier: Apache-2.0
//
// The guard's classifier (specs/guard/spec.md, "Actions"): what a tool call
// will do, named in a fixed vocabulary the policy matches on. Action names are
// public API. The shell tokenizer here is also the one the self-evolution loop
// uses for its own shell gate (scripts/findings-lib.mjs), so there is one
// parser, measured in both places (F-133).
//
// No I/O except resolving real paths (symlinks), which callers may replace.

import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Input over this many characters is refused as unclassifiable (C-04). */
export const MAX_COMMAND = 64 * 1024;

export class ClassifyError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

/**
 * Split a command into segments (arrays of words) outside quotes, collecting
 * output-redirect targets, whether anything opaque (heredoc, command
 * substitution) appears, and whether a variable or brace expansion the guard
 * cannot resolve statically does (F-176). Linear in the length; no backtracking.
 */
export function shellSegments(cmd) {
  const segs = [];
  const redirects = [];
  let words = [];
  let w = '';
  let inWord = false;
  let q = null;
  let opaque = false;
  let expands = false; // a variable or brace expansion the guard cannot resolve (F-176)
  let uq = ''; // the word's unquoted text: quoted or escaped braces never expand
  let wantTarget = false;
  let heredoc = null; // delimiter waiting for the end of the line
  let hasRedirect = false;
  const endWord = () => {
    if (inWord) {
      // a brace with a comma or range in the word's unquoted text expands (F-176)
      if (/\{[^{}]*(,|\.\.)[^{}]*\}/.test(uq)) expands = true;
      if (wantTarget) {
        redirects.push({ seg: segs.length, target: w }); // resolved in its own segment's directory
        wantTarget = false;
        hasRedirect = true;
      } else words.push(w);
    }
    w = '';
    uq = '';
    inWord = false;
  };
  const endSeg = () => {
    endWord();
    if (words.length || hasRedirect) segs.push(words);
    words = [];
    hasRedirect = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q === "'") {
      if (c === "'") q = null;
      else w += c;
      continue;
    }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === '\\' && i + 1 < cmd.length) w += cmd[++i];
      else {
        if (c === '`' || (c === '$' && cmd[i + 1] === '(')) opaque = true;
        else if (c === '$' && /[\w{@*#?$!-]/.test(cmd[i + 1] ?? '')) expands = true;
        w += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      inWord = true;
      continue;
    }
    if (c === '\\') {
      if (cmd[i + 1] === '\n') i++;
      else if (i + 1 < cmd.length) {
        w += cmd[++i];
        inWord = true;
      }
      continue;
    }
    if (c === '#' && !inWord) {
      while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++;
      continue;
    }
    if (c === '`' || (c === '$' && cmd[i + 1] === '(')) {
      opaque = true;
      w += c;
      inWord = true;
      continue;
    }
    if (c === '\n') {
      endSeg();
      if (heredoc !== null) {
        // skip the body up to the delimiter line
        const { delim, strip } = heredoc;
        heredoc = null;
        let j = i + 1;
        for (;;) {
          const e = cmd.indexOf('\n', j);
          const line = cmd.slice(j, e < 0 ? cmd.length : e);
          if ((strip ? line.replace(/^\t+/, '') : line) === delim || e < 0) {
            i = e < 0 ? cmd.length : e;
            break;
          }
          j = e + 1;
        }
      }
      continue;
    }
    if (c === '<') {
      endWord();
      if (cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
        opaque = true;
        i += 2;
        const strip = cmd[i] === '-';
        if (strip) i++;
        while (cmd[i] === ' ' || cmd[i] === '\t') i++;
        const m = /^(?:'([^'\n]*)'|"([^"\n]*)"|([^\s;&|<>()]+))/.exec(cmd.slice(i, i + 256));
        if (m) {
          heredoc = { delim: m[1] ?? m[2] ?? m[3], strip };
          i += m[0].length - 1;
        } else i--;
      } else if (cmd[i + 1] === '<') i += 2; // here-string
      continue;
    }
    if (c === '>') {
      if (inWord && /^\d+$/.test(w)) {
        w = '';
        uq = '';
        inWord = false;
      } else endWord();
      if (cmd[i + 1] === '>' || cmd[i + 1] === '|') i++;
      if (cmd[i + 1] === '&') {
        i++;
        if (/[\d-]/.test(cmd[i + 1] ?? '')) {
          while (/[\d-]/.test(cmd[i + 1] ?? '')) i++;
          continue;
        }
      }
      wantTarget = true;
      continue;
    }
    if (c === '&' && cmd[i + 1] === '>') {
      endWord();
      i++;
      if (cmd[i + 1] === '>') i++;
      wantTarget = true;
      continue;
    }
    if (c === '|' || c === '&' || c === ';' || c === '(' || c === ')' || c === '{' || c === '}') {
      if ((c === '{' || c === '}') && inWord) {
        w += c;
        uq += c;
        continue;
      }
      // a word-start brace holding anything but a lone `}` (a `{}` placeholder,
      // a `{ group; }`) is a brace expansion the shell performs later (F-176)
      if (c === '{' && /[^\s}]/.test(cmd[i + 1] ?? '')) expands = true;
      endSeg();
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      continue;
    }
    if (c === '$' && /[\w{@*#?$!-]/.test(cmd[i + 1] ?? '')) expands = true;
    w += c;
    uq += c;
    inWord = true;
  }
  endSeg();
  if (q !== null) opaque = true; // unterminated quote: cannot be read
  return { segs, redirects, opaque, expands };
}

// --- scopes -------------------------------------------------------------------

/** The real path of the nearest existing part, plus the rest: symlinks resolved, `..` gone. */
export function realOf(p) {
  const tail = [];
  let d = resolve(p);
  for (;;) {
    try {
      return join(realpathSync.native(d), ...tail);
    } catch {
      const up = dirname(d);
      if (up === d) return resolve(p);
      tail.unshift(basename(d));
      d = up;
    }
  }
}

/**
 * Canonical scope of a path (spec "Scopes"): repo-relative inside the
 * repository, `~sakk/…` under SAKK_HOME, `~home/…` under the home folder,
 * otherwise `~outside/<absolute>`. The home folder is named before the
 * absolute path so that an allow written for a folder (a temp folder) never
 * covers it, wherever HOME lives (`HOME=/tmp` in containers; F-146). The
 * kernel matches canonical relative paths only, so these are the only shapes.
 */
export function scopeOf(path, { repoRoot, sakkHome, homeDir, real = realOf }) {
  const abs = real(path);
  const under = (base) => {
    if (!base) return null;
    const r = relative(real(base), abs);
    if (r === '') return '.';
    return r.startsWith('..') || isAbsolute(r) ? null : r.split(sep).join('/');
  };
  const inSakk = under(sakkHome);
  if (inSakk !== null) return inSakk === '.' ? '~sakk' : `~sakk/${inSakk}`;
  const inRepo = under(repoRoot);
  if (inRepo !== null) {
    if (inRepo === '.') return null; // the repository itself: no canonical relative name, so no scope

    if (inRepo.startsWith('~'))
      throw new ClassifyError(
        'HOOK_PATH_UNREADABLE',
        `a repository path may not start with ~: ${inRepo}`,
      );
    return inRepo;
  }
  const inHome = under(homeDir);
  if (inHome !== null) return inHome === '.' ? '~home' : `~home/${inHome}`;
  const parts = abs.split(sep).filter(Boolean);
  return parts.length ? `~outside/${parts.join('/')}` : '~outside';
}

// --- secret files (the guard's first line; M3 adds content checks) ---------

const SECRET_NAME =
  /^(\.env(\..+)?|.*\.pem|.*\.key|id_(rsa|dsa|ecdsa|ed25519)(\.old)?|.*\.p12|.*\.pfx|.*\.keystore|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.git-credentials|credentials|\.htpasswd)$/i;
const NOT_SECRET = /^\.env\.(example|sample|template|defaults?|dist)$/i;
// the process-environment pseudo-file is every exported secret at once (F-203)
const PROC_ENVIRON = /^\/proc\/(\d+|self|thread-self)(\/task\/\d+)?\/environ$/;
export const isSecretPath = (p) => {
  if (PROC_ENVIRON.test(p)) return true;
  const b = basename(p);
  return SECRET_NAME.test(b) && !NOT_SECRET.test(b);
};

// --- shell --------------------------------------------------------------------

/**
 * Wrapper commands, the flags of each that take a value (`sudo -u root`) and
 * one sample of such a flag: the value is skipped with its flag, or it would
 * be read as the command's name (F-145). A wrapper is added here with its
 * value flags and a sample, never alone; the guard tests run every sample.
 */
export const WRAPPERS = new Map([
  [
    'sudo',
    {
      values: /^-[ugCDhprtUT]$|^--(user|group|close-from|chdir|host|prompt|role|type|other-user)$/,
      sample: '-u root',
    },
  ],
  ['doas', { values: /^-[uC]$/, sample: '-u root' }],
  ['nice', { values: /^-n$|^--adjustment$/, sample: '-n 5' }],
  ['time', { values: /^-[fo]$|^--(format|output)$/, sample: '-o /dev/null' }],
  ['timeout', { values: /^-[sk]$|^--(signal|kill-after)$/, sample: '-s KILL 30' }],
  ['exec', { values: /^-a$/, sample: '-a name' }],
  ['nohup', { values: null, sample: '' }],
  ['command', { values: null, sample: '-p' }],
  ['builtin', { values: null, sample: '' }],
]);
const READERS = new Set(
  'cat head tail less more bat nl od xxd hexdump strings tac wc file stat cut sort uniq diff cmp'.split(
    ' ',
  ),
);
const GREPS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);
// shell builtins that bind or unbind names: their arguments spell names, never
// files they read, so the F-203 piece scan does not judge them
const BINDERS = new Set([
  'export',
  'declare',
  'typeset',
  'local',
  'readonly',
  'set',
  'unset',
  'alias',
]);
/**
 * Commands whose whole purpose is printing or handing over a credential: a
 * closed set, each member pinned by a test, so a new member is added together
 * with its test (F-203). They print the secret with no secret-named file in
 * the command's text.
 */
const credentialPrint = (name, plain, args) => {
  if (name === 'gh' && plain[0] === 'auth')
    return (
      plain[1] === 'token' ||
      (plain[1] === 'status' && args.some((a) => /^--show-token$|^-t$/.test(a)))
    );
  if (name === 'aws' && plain[0] === 'configure')
    return (
      plain[1] === 'export-credentials' ||
      (plain[1] === 'get' && /(secret|token|key|password)/i.test(plain[2] ?? ''))
    );
  if (name === 'aws' && plain[0] === 'sts')
    return /^(get-session-token|get-federation-token|assume-role)/.test(plain[1] ?? '');
  if (name === 'npm' && plain[0] === 'token') return true;
  if (name === 'npm' && plain[0] === 'config' && plain[1] === 'get')
    return /(_auth|token|password)/i.test(plain[2] ?? '');
  if (name === 'gcloud' && plain[0] === 'auth')
    return /^print-(access|identity)-token$/.test(plain[1] ?? '');
  return false;
};
// commands that run another under a pseudo-terminal, and can type into it: the
// confirmation `sakk cap off` asks a person for must not be answerable this way (F-171)
const PTY_DRIVERS = new Set(['script', 'expect', 'unbuffer']);
/** Where each agent keeps the hook config `sakk guard` writes, from the base folder. */
export const AGENT_CONFIG = Object.freeze({
  'claude-code': join('.claude', 'settings.json'),
  cursor: join('.cursor', 'hooks.json'),
  codex: join('.codex', 'hooks.json'),
});
const INTERPRETERS = /^(python[\d.]*|node|deno|bun|ruby|perl|php)$/;
const SHELLS = /^(sh|bash|zsh|dash|ksh|fish)$/;
const DEFAULT_BRANCHES = /^(main|master|trunk|develop)$/;

/** Strip environment assignments and wrapper commands; the word that remains names the command. */
function unwrap(seg) {
  let k = 0;
  for (;;) {
    const w = seg[k] ?? '';
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) k++;
    else if (WRAPPERS.has(basename(w))) {
      const { values } = WRAPPERS.get(basename(w));
      k++;
      // the wrapper's own flags, and the value of each flag that takes one
      while ((seg[k] ?? '').startsWith('-')) k += values?.test(seg[k]) ? 2 : 1;
      if (basename(w) === 'timeout') k++; // the duration
    } else if (basename(w) === 'env') {
      k++;
      while ((seg[k] ?? '').startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[k] ?? ''))
        k += /^-[uSC]$|^--(unset|chdir|split-string)$/.test(seg[k]) ? 2 : 1;
      if (k >= seg.length) return { name: 'env', args: [] }; // bare env prints the environment
    } else break;
  }
  const words = seg.slice(k);
  return { name: basename(words[0] ?? ''), args: words.slice(1) };
}

const dedupe = (list) => {
  const seen = new Set();
  return list.filter((a) => {
    const k = `${a.action}\u0000${a.path ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/**
 * Actions a shell command takes: [{ action, path? }]. Paths are absolute,
 * resolved against the command's own `cd`s; the caller turns them into
 * scopes. A form the classifier does not know is `shell.run`.
 */
export function shellActions(
  cmd,
  cwd,
  { home = process.env.HOME ?? '', sakkHome = '', repoRoot = null, depth = 0 } = {},
) {
  if (typeof cmd !== 'string')
    throw new ClassifyError('HOOK_PAYLOAD_INVALID', 'the command is not text');
  if (cmd.length > MAX_COMMAND)
    throw new ClassifyError(
      'HOOK_INPUT_TOO_LARGE',
      `the command is longer than ${MAX_COMMAND} characters`,
    );
  const out = [];
  const add = (action, path) => out.push(path === undefined ? { action } : { action, path });
  const { segs, redirects, opaque, expands } = shellSegments(cmd);
  if (opaque) add('shell.constructed'); // command substitution, a heredoc or an unterminated quote
  // a variable or brace expansion the guard cannot resolve statically: the
  // shell substitutes it after the hook judged the written word, so the
  // command is constructed — asked, never allowed (F-176)
  if (expands) add('shell.constructed');
  // curl … | sh, base64 -d | bash: the text that runs is built at run time
  if (/\|\s*(sudo\s+)?(sh|bash|zsh|dash|python[\d.]*|node|perl|ruby)\b/.test(cmd))
    add('shell.constructed');
  let here = cwd;
  const abs = (p) =>
    p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : resolve(here, p);
  for (const [i, seg] of segs.entries()) {
    for (const r of redirects.filter((x) => x.seg === i))
      if (!/^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/.test(r.target))
        add('file.write', abs(r.target));
    const { name, args } = unwrap(seg);
    if (!name) continue;
    const plain = args.filter((a) => !a.startsWith('-'));
    const has = (re) => args.some((a) => re.test(a));
    // a secret filename is judged wherever it appears in the command — inside
    // an upload reference (`file=@…`), a git version-path (`HEAD:…`), a mount
    // or remote-copy spec — not only as a plain operand of a known reader (F-203)
    if (!BINDERS.has(name))
      for (const a of args)
        if (/[=@:]/.test(a))
          for (const piece of a.split(/[=@:]+/))
            if (piece && isSecretPath(piece)) add('secret.read', abs(piece));
    if (name === 'cd') {
      if (plain[0] && plain[0] !== '-') here = abs(plain[0]);
      continue;
    }
    if (name === 'eval' || name === 'source' || name === '.') {
      add('shell.constructed');
      continue;
    }
    if (SHELLS.test(name)) {
      const ci = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
      const script = ci >= 0 ? args[ci + 1] : undefined;
      if (script === undefined) add('shell.run');
      else if (/[$`]/.test(script) || depth >= 3) add('shell.constructed');
      else out.push(...shellActions(script, here, { home, sakkHome, repoRoot, depth: depth + 1 }));
      continue;
    }
    if (name === 'git') {
      // a spelled-out secret among git's arguments is reached whatever the
      // subcommand does with it — add, diff, show, stash alike (F-203)
      for (const a of args) if (!a.startsWith('-') && isSecretPath(a)) add('secret.read', abs(a));
      gitActions(args, here, abs, add);
      continue;
    }
    if (['rm', 'rmdir', 'unlink', 'shred'].includes(name)) {
      for (const f of plain) add('file.delete', abs(f));
      continue;
    }
    if (name === 'dd') {
      // dd names its files by if=/of=, not as positional words (F-153)
      for (const a of args)
        if (a.startsWith('of=')) add('file.write', abs(a.slice(3)));
        else if (a.startsWith('if=')) add('file.read', abs(a.slice(3)));
      continue;
    }
    if (name === 'tar') {
      // an extraction writes into its directory; otherwise the archive is written
      // and its members read; --remove-files deletes the members (F-153)
      const extract = has(/^-?[a-zA-Z]*x[a-zA-Z]*$|^--extract$|^--get$/);
      const fi = args.findIndex((a) => /^-?[a-zA-Z]*f$|^--file$/.test(a));
      const archive = fi >= 0 ? args[fi + 1] : undefined;
      const ci = args.findIndex((a) => a === '-C' || a === '--directory');
      const into = ci >= 0 ? args[ci + 1] : '.';
      const members = plain.filter((a) => a !== archive && a !== into);
      if (extract) add('file.write', abs(into));
      else if (archive && archive !== '-') add('file.write', abs(archive));
      const remove = has(/^--remove-files$/);
      for (const m of members) add(remove ? 'file.delete' : 'file.read', abs(m));
      continue;
    }
    if (name === 'rsync') {
      // --delete removes dest files missing from source; --remove-source-files
      // deletes what it sent — both destroy, so name them (F-153)
      const dest = plain.at(-1);
      for (const f of plain.slice(0, -1)) add('file.read', abs(f));
      if (dest) add(has(/^--delete/) ? 'file.delete' : 'file.write', abs(dest));
      if (has(/^--remove-source-files$/))
        for (const f of plain.slice(0, -1)) add('file.delete', abs(f));
      continue;
    }
    if (name === 'find') {
      const roots = [];
      for (const a of args) {
        if (a.startsWith('-') || a === '(' || a === '!') break;
        roots.push(a);
      }
      const over = roots.length ? roots : ['.'];
      if (has(/^-delete$/)) for (const r of over) add('file.delete', abs(r));
      const ex = args.findIndex((a) => /^-(exec|execdir|ok|okdir)$/.test(a));
      if (ex >= 0) {
        // what find runs on each match is judged as if run on each root (F-154)
        const inner = unwrap(
          args.slice(ex + 1).filter((a) => a !== ';' && a !== '+' && a !== '{}'),
        );
        if (['rm', 'rmdir', 'unlink', 'shred'].includes(inner.name))
          for (const r of over) add('file.delete', abs(r));
        else if (READERS.has(inner.name) || GREPS.has(inner.name))
          for (const r of over) add('file.read', abs(r));
        else for (const r of over) add('file.write', abs(r));
      } else if (!has(/^-delete$/)) add('shell.run');
      continue;
    }
    if (name === 'xargs') {
      // the words come from stdin, so the real command is built at run time;
      // only a reader is safe to treat as read, anything else is constructed (F-154)
      let k = 0;
      while ((args[k] ?? '').startsWith('-')) k += /^-[IdLnPsE]$/.test(args[k]) ? 2 : 1;
      const inner = basename(args[k] ?? '');
      add(
        READERS.has(inner) || GREPS.has(inner) || inner === 'echo'
          ? 'shell.run'
          : 'shell.constructed',
      );
      continue;
    }
    if (/^(perl|ruby)$/.test(name) && has(/^-[a-zA-Z]*i/)) {
      // in-place edit: the operand files are written (F-153, like sed -i)
      for (const f of plain) add('file.write', abs(f));
      continue;
    }
    if (name === 'mv') {
      // a move reads the source into the destination before unlinking it, so a
      // secret source is a secret read, not only a delete (F-203)
      for (const f of plain.slice(0, -1)) {
        add('file.read', abs(f));
        add('file.delete', abs(f));
      }
      if (plain.length) add('file.write', abs(plain.at(-1)));
      continue;
    }
    if (['cp', 'install', 'ln', 'rsync'].includes(name)) {
      // A link (ln, or cp -s/-l) created mid-chain defeats static path
      // resolution: a later write/read through the new name resolves to the cwd
      // at classify time but to the link's target at run time — the symlink/
      // hard-link TOCTOU that let an agent reach ~/.sakk in one command (F-163).
      // The guard cannot follow a link that does not exist yet, so a chained
      // link-create is treated as constructed (a person approves it).
      const makesLink = name === 'ln' || (name === 'cp' && has(/^-[a-z]*[sl]|^--(symbolic|link)/));
      if (makesLink && segs.length > 1) add('shell.constructed');
      for (const f of plain.slice(0, -1)) add('file.read', abs(f));
      if (plain.length) add('file.write', abs(plain.at(-1)));
      continue;
    }
    if (['tee', 'touch', 'mkdir', 'truncate'].includes(name)) {
      for (const f of plain) add('file.write', abs(f));
      continue;
    }
    if (name === 'chmod' || name === 'chown') {
      for (const f of plain.slice(1)) add('file.write', abs(f));
      continue;
    }
    if (name === 'sed' && has(/^-[a-zA-Z]*i|^--in-place/)) {
      for (const f of plain.slice(1)) add('file.write', abs(f));
      continue;
    }
    if (READERS.has(name)) {
      for (const f of plain) add('file.read', abs(f));
      continue;
    }
    if (name === 'sed' || name === 'awk' || name === 'jq') {
      for (const f of plain.slice(1)) add('file.read', abs(f));
      continue;
    }
    if (GREPS.has(name)) {
      const skip = args.includes('-e') || args.includes('-f') ? 0 : 1;
      for (const f of plain.slice(skip)) add('file.read', abs(f));
      continue;
    }
    if (
      name === 'printenv' ||
      (name === 'env' && args.length === 0) ||
      (name === 'set' && args.length === 0) ||
      (name === 'export' && args.includes('-p')) ||
      (name === 'declare' && has(/^-[a-z]*x/))
    ) {
      add('secret.read');
      continue;
    }
    const verb = plain[0];
    const joined = args.join(' ');
    let modeled = true;
    // a command whose whole purpose is printing a credential is a secret read (F-203)
    if (credentialPrint(name, plain, args)) add('secret.read');
    else if (name === 'kubectl' && verb === 'delete') add('prod.delete');
    else if (name === 'kubectl' && ['apply', 'replace', 'rollout', 'create'].includes(verb))
      add('deploy');
    else if (name === 'terraform' && verb === 'destroy') add('prod.delete');
    else if (name === 'terraform' && verb === 'apply') add('deploy');
    else if (
      name === 'aws' &&
      verb === 's3' &&
      (plain[1] === 'rb' || (plain[1] === 'rm' && has(/^--recursive$/)))
    )
      add('prod.delete');
    else if (name === 'gcloud' && plain.includes('delete')) add('prod.delete');
    else if (['dropdb', 'dropuser'].includes(name)) add('prod.delete');
    else if (
      ['psql', 'mysql', 'sqlite3', 'mongosh', 'mongo', 'redis-cli'].includes(name) &&
      /\b(drop\s+(table|database|schema)|truncate\s+table|flushall|flushdb|dropDatabase)\b/i.test(
        joined,
      )
    )
      add('prod.delete');
    else if (['vercel', 'netlify'].includes(name) && (has(/^--prod$/) || verb === 'deploy'))
      add('deploy');
    else if (['fly', 'flyctl'].includes(name) && verb === 'deploy') add('deploy');
    else if (name === 'railway' && verb === 'up') add('deploy');
    else if (name === 'npm' && verb === 'publish') add('deploy');
    else if (name === 'gh' && verb === 'release' && plain[1] === 'create') add('deploy');
    else if (
      ['npm', 'pnpm', 'yarn', 'bun'].includes(name) &&
      ['install', 'i', 'add'].includes(verb) &&
      plain.length > 1
    )
      add('package.install');
    else if (
      ['pip', 'pip3', 'brew', 'gem', 'apt', 'apt-get', 'cargo', 'go'].includes(name) &&
      ['install', 'add'].includes(verb)
    )
      add('package.install');
    else if (name === 'uv' && (verb === 'add' || (verb === 'pip' && plain[1] === 'install')))
      add('package.install');
    else if (name === 'curl' && has(/^-(o|O)$|^--output|^--remote-name|^-[a-zA-Z]*[oO]$/))
      add('net.download');
    else if (name === 'wget') add('net.download');
    else if (INTERPRETERS.test(name) && has(/^-(c|e)$|^--eval$/)) add('shell.constructed');
    else if (PTY_DRIVERS.has(name)) add('shell.constructed');
    // Sakk's own commands that change its controls are the writes they make, so
    // the agent is judged as if it wrote the file: the cap, and the ledger the
    // hook reads halts from, are guard state (denied); the hook config is agent
    // config (denied, F-188). A person runs them (F-171, F-181). Every subcommand
    // is declared by its effect in test/kill-switch.test.mjs (R-24).
    else if (name === 'sakk' && (verb === 'cap' || verb === 'init') && sakkHome)
      add('file.write', join(sakkHome, 'config.json'));
    // resume, reconcile and unlock lift a halt, clear the books or break the
    // lock — the inverse of the controls that bind the agent, judged as the
    // guard-state write they make: denied, never asked (F-177, D11). `halt`
    // tightens and stays allowed.
    else if (name === 'sakk' && ['resume', 'reconcile', 'unlock'].includes(verb) && sakkHome)
      add('file.write', join(sakkHome, 'sakk-ledger.json'));
    // gateway init writes the start script an operator later runs, naming the
    // ledger the gateway charges and the executable it starts: judged as that
    // write, in the folder it really writes (--dir, else SAKK_HOME/gateway)
    else if (name === 'sakk' && verb === 'gateway' && sakkHome) {
      const d = args.indexOf('--dir');
      const dir = d >= 0 && args[d + 1] ? abs(args[d + 1]) : join(sakkHome, 'gateway');
      add('file.write', join(dir, 'start.sh'));
    } else if (
      name === 'sakk' &&
      verb === 'guard' &&
      ['install', 'uninstall'].includes(plain[1]) &&
      Object.hasOwn(AGENT_CONFIG, plain[2] ?? '')
    )
      add('file.write', join(has(/^--user$/) ? home : (repoRoot ?? here), AGENT_CONFIG[plain[2]]));
    else modeled = false;
    // a spelled-out secret operand is a secret read whether or not the command
    // is otherwise modeled — the reader list is not the whole world (F-155, F-203)
    const secrets = plain.filter((a) => isSecretPath(a));
    for (const a of secrets) add('secret.read', abs(a));
    if (!modeled && secrets.length === 0) add('shell.run');
  }
  return dedupe(out);
}

/** The git subcommands gitActions judges; everything else is shell.run. */
const GIT_JUDGED = new Set([
  'push',
  'reset',
  'branch',
  'filter-branch',
  'filter-repo',
  'clean',
  'rm',
  'mv',
  'checkout',
  'restore',
  'clone',
  'credential',
  'credential-store',
  'credential-cache',
]);

function gitActions(args, here, abs, add) {
  let j = 0;
  // git's own options, some taking the next word as a value; an unregistered
  // value option must not let its value be read as the subcommand (F-156), so
  // if the word we land on is not a judged subcommand we scan on for one
  while (j < args.length && args[j].startsWith('-'))
    j += /^-(C|c)$|^--(git-dir|work-tree|namespace|super-prefix|config-env|exec-path)$/.test(
      args[j],
    )
      ? 2
      : 1;
  if (!GIT_JUDGED.has(args[j])) {
    const k = args.findIndex((a, i) => i > j && GIT_JUDGED.has(a));
    if (k >= 0) j = k;
  }
  const sub = args[j];
  const rest = args.slice(j + 1);
  const plain = rest.filter((a) => !a.startsWith('-'));
  const has = (re) => rest.some((a) => re.test(a));
  const dd = rest.indexOf('--');
  const paths = dd >= 0 ? rest.slice(dd + 1) : [];
  switch (sub) {
    case 'push':
      if (
        has(/^(-f|--force|--force-with-lease(=.*)?|--force-if-includes|--mirror|--delete|-d)$/) ||
        plain.slice(1).some((r) => r.startsWith('+') || r.startsWith(':'))
      )
        add('git.destructive');
      else add('shell.run');
      return;
    case 'reset':
      add(has(/^--(hard|merge|keep)$/) ? 'git.destructive' : 'shell.run');
      return;
    case 'branch':
      if (has(/^(-D|-d|--delete)$/) && plain.some((b) => DEFAULT_BRANCHES.test(b)))
        add('git.destructive');
      else add('shell.run');
      return;
    case 'filter-branch':
    case 'filter-repo':
      add('git.destructive');
      return;
    case 'clean':
      add(has(/^-[a-zA-Z]*f|^--force$/) ? 'file.delete' : 'shell.run', here);
      return;
    case 'rm':
      if (rest.includes('--cached')) add('shell.run');
      else for (const f of plain) add('file.delete', abs(f));
      return;
    case 'mv':
      for (const f of plain.slice(0, -1)) add('file.delete', abs(f));
      if (plain.length) add('file.write', abs(plain.at(-1)));
      return;
    case 'checkout':
    case 'restore':
      if (paths.length) for (const f of paths) add('file.write', abs(f));
      else if (sub === 'restore')
        for (const f of plain.length ? plain : ['.']) add('file.write', abs(f));
      else add('shell.run');
      return;
    case 'clone':
      add('net.download');
      return;
    case 'credential':
    case 'credential-store':
    case 'credential-cache':
      // their whole purpose is reading or storing a credential (F-203)
      add('secret.read');
      return;
    default:
      add('shell.run');
  }
}

// --- patches (Codex apply_patch) ------------------------------------------

/** Files an apply_patch body touches: `*** Add|Update|Delete File: p` and `*** Move to: p`. */
export function patchActions(patch, cwd) {
  if (typeof patch !== 'string')
    throw new ClassifyError('HOOK_PAYLOAD_INVALID', 'the patch is not text');
  if (patch.length > 8 * MAX_COMMAND)
    throw new ClassifyError('HOOK_INPUT_TOO_LARGE', 'the patch is too large to classify');
  const out = [];
  for (const m of patch.matchAll(/^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/gm))
    out.push({
      action: m[1] === 'Delete File' ? 'file.delete' : 'file.write',
      path: resolve(cwd, m[2].trim()),
    });
  if (out.length === 0) out.push({ action: 'shell.constructed' }); // a patch whose files cannot be read
  return dedupe(out);
}

/** Final step: paths become scopes; reads of secret files become secret.read. */
/**
 * What a delete would take with it (F-146): a target that contains the
 * repository, the home folder or Sakk's state is named `~protected/<what>`,
 * so no allow written for a folder (a temp folder, the repository) can match
 * it — deleting a parent deletes everything under it.
 */
function protectedBy(path, { repoRoot, sakkHome, homeDir, real = realOf }) {
  const abs = real(path);
  const contains = (base) => {
    if (!base) return false;
    const r = relative(abs, real(base));
    return r === '' || !(r.startsWith('..') || isAbsolute(r));
  };
  if (contains(repoRoot)) return 'repo';
  if (contains(homeDir)) return 'home';
  if (contains(sakkHome)) return 'sakk';
  return null;
}

export function toDecisions(actions, ctx) {
  return actions.map(({ action, path }) => {
    if (path === undefined) return { action };
    if (action === 'file.delete') {
      const what = protectedBy(path, ctx);
      if (what !== null) return { action, scope: `~protected/${what}` };
    }
    const scope = scopeOf(path, ctx);
    const named = action === 'file.read' && isSecretPath(path) ? 'secret.read' : action;
    return scope === null ? { action: named } : { action: named, scope };
  });
}
