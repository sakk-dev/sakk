#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// One heavy run at a time on this machine (findings F-220). The gate, the
// mutation drill, the audit, the gate certificate and the pre-push suite each
// keep every core busy for minutes. Two at once starve each other's tests: a
// guard test that passes alone in 0.8 s was killed at its 240 s spawn bound
// while a drill ran beside the gate. A second heavy run refuses at its start
// and names the run that holds the lock; it does not wait.
//
// The lock is a directory published with one rename(2), which is atomic and
// fails while the target exists and is not empty: the directory mutex of
// BashFAQ/045 and the Bash Hackers wiki, without flock(1), which macOS does
// not ship. Its `owner` file reads `<pid> <ISO time> <what>`. A lock whose pid
// is gone (a run killed with SIGKILL never releases) is taken over by the
// next run.
//
// A run started inside a holder (the drill inside the audit or the
// certificate) finds the holder's pid in SAKK_HEAVY_LOCK_PID and runs in that
// lock without releasing it.
//
//   node scripts/heavy-lock.mjs acquire <what> <pid>   prints the holder's pid, exit 0;
//                                                      refused: the reason on stderr, exit 1
//   node scripts/heavy-lock.mjs release <pid>          exit 0
//
// SAKK_HEAVY_LOCK names the lock directory (the tests point it at a temp
// folder); the default is <os tmpdir>/sakk-heavy-run.lock, one per user.

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCK_ENV = 'SAKK_HEAVY_LOCK_PID';
const TRIES = 3;
// what rename(2) says when the lock is already there
const HELD = new Set(['ENOTEMPTY', 'EEXIST', 'ENOTDIR', 'EISDIR']);

export const lockDir = (env = process.env) =>
  env.SAKK_HEAVY_LOCK || join(tmpdir(), 'sakk-heavy-run.lock');

const validPid = (pid) => Number.isSafeInteger(pid) && pid > 1;

/** True while `pid` names a running process; EPERM means it runs as another user. */
export function alive(pid) {
  if (!validPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * The lock's owner, or null when there is no lock. A lock this module did not
 * write (no owner file, or one in another shape) has pid NaN: no live run
 * holds it, so the next run takes it over.
 */
export function holder(dir = lockDir()) {
  try {
    lstatSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  let text = '';
  try {
    text = readFileSync(join(dir, 'owner'), 'utf8');
  } catch {
    // unreadable: handled as a lock nobody holds
  }
  const m = /^(\d+) (\S+) ([^\n]*)\n?$/.exec(text);
  return m
    ? { pid: Number(m[1]), since: m[2], what: m[3], text }
    : { pid: NaN, since: '?', what: 'an unreadable lock', text };
}

/**
 * Take the lock for `pid`. {ok: true, owner} when it is ours, or when its
 * holder is `pid` itself or the run named in SAKK_HEAVY_LOCK_PID (nested:
 * true, and the caller must not release it); {ok: false, holder} when another
 * live run holds it.
 */
export function acquire(what, pid = process.pid, env = process.env) {
  const dir = lockDir(env);
  const owner = `${pid} ${new Date().toISOString()} ${String(what).replace(/\s+/g, ' ')}\n`;
  mkdirSync(dirname(dir), { recursive: true });
  let last = null;
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    const draft = `${dir}.new-${pid}-${process.pid}`;
    rmSync(draft, { recursive: true, force: true });
    mkdirSync(draft);
    writeFileSync(join(draft, 'owner'), owner);
    try {
      renameSync(draft, dir);
      return { ok: true, owner: pid, nested: false, dir };
    } catch (e) {
      rmSync(draft, { recursive: true, force: true });
      if (!HELD.has(e.code)) throw e;
    }
    const h = holder(dir);
    last = h;
    if (h === null) continue; // released between the rename and the read
    if (alive(h.pid)) {
      if (h.pid === pid || env[LOCK_ENV] === String(h.pid))
        return { ok: true, owner: h.pid, nested: true, dir };
      return { ok: false, holder: h, dir };
    }
    // Its run is gone: move the lock aside and remove it. If a live run
    // published a new lock between the read and the move, the moved lock is
    // that one: put it back and look again.
    const aside = `${dir}.stale-${pid}-${process.pid}-${attempt}`;
    rmSync(aside, { recursive: true, force: true });
    try {
      renameSync(dir, aside);
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    const moved = holder(aside);
    if (moved && moved.text !== h.text && alive(moved.pid)) {
      try {
        renameSync(aside, dir);
        continue;
      } catch {
        // a third run published meanwhile; the moved lock cannot go back
      }
    }
    rmSync(aside, { recursive: true, force: true });
  }
  return { ok: false, holder: last, dir };
}

/** Remove the lock if `pid` holds it; true when it did. */
export function release(pid = process.pid, env = process.env) {
  const dir = lockDir(env);
  const h = holder(dir);
  if (!h || h.pid !== pid) return false;
  // only a live holder releases, and only a dead holder's lock is taken over,
  // so the lock cannot change hands between the read and the move
  const done = `${dir}.done-${pid}-${process.pid}`;
  try {
    renameSync(dir, done);
  } catch {
    return false;
  }
  rmSync(done, { recursive: true, force: true });
  return true;
}

/** Why a heavy run was refused, and what to do. */
export function refusal(what, r) {
  const h = r.holder;
  const who = h && validPid(h.pid) ? `${h.what} (pid ${h.pid}, since ${h.since})` : 'another run';
  return (
    `heavy-lock: refused ${what}: ${who} holds the machine-wide lock ${r.dir}; ` +
    `wait for it to finish and run again — two heavy runs at once kill tests that pass ` +
    `alone (F-220). A lock left by a crashed run is taken over once its pid is gone.`
  );
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const usage = () => {
    process.stderr.write('usage: heavy-lock.mjs acquire <what> <pid> | release <pid>\n');
    process.exit(2);
  };
  const pidArg = (s) => (/^[1-9]\d*$/.test(s ?? '') ? Number(s) : usage());
  if (cmd === 'acquire' && rest.length === 2 && rest[0].trim() !== '') {
    const pid = pidArg(rest[1]);
    let r;
    try {
      r = acquire(rest[0], pid);
    } catch (e) {
      process.stderr.write(`heavy-lock: could not take the lock ${lockDir()}: ${e.message}\n`);
      process.exit(1);
    }
    if (!r.ok) {
      process.stderr.write(`${refusal(rest[0], r)}\n`);
      process.exit(1);
    }
    process.stdout.write(`${r.owner}\n`);
  } else if (cmd === 'release' && rest.length === 1) {
    release(pidArg(rest[0]));
  } else usage();
}
