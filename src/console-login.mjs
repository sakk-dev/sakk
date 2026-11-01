// SPDX-License-Identifier: AGPL-3.0-only
//
// Basic username + password sign-in for `sakk ui` (the maintainer, 2026-11-01: the most
// basic login, account and password; anything more is V2). Opt-in: with no
// credential file the console keeps its token-only behaviour.
//
// Storage follows the OWASP Password Storage cheat sheet: scrypt N=2^17, r=8,
// p=1 with a 16-byte random salt, kept in an owner-only file. Sessions follow
// the OWASP Session Management cheat sheet: a fresh 128-bit id per sign-in,
// held in memory only, with an idle and an absolute limit.

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants as FS,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { writeFileAtomic } from './append.mjs';

export const LOGIN_FILE = 'console-login.json';
/** The only parameters a credential file may carry (no silent downgrade). */
export const SCRYPT_PARAMS = Object.freeze({ N: 2 ** 17, r: 8, p: 1, keylen: 64 });
// scrypt needs 128 * N * r bytes (128 MiB here); Node's default cap is 32 MiB
const MAXMEM = 256 * 1024 * 1024;
const SALT_BYTES = 16;
const FILE_CAP = 4096;
export const USERNAME_MAX = 64;
// NIST SP 800-63B-4: a password used on its own is at least 15 characters
export const PASSWORD_MIN = 15;
export const PASSWORD_MAX = 1024;
export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_MAX_MS = 8 * 60 * 60 * 1000;
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 16;

export class ConsoleLoginError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const loginPath = (home) => join(home, LOGIN_FILE);

/** A username is 1–64 printable characters, no spaces at either end. */
export function checkUsername(u) {
  if (
    typeof u !== 'string' ||
    u.length < 1 ||
    u.length > USERNAME_MAX ||
    u.trim() !== u ||
    /\p{Cc}/u.test(u)
  )
    throw new ConsoleLoginError(
      'UI_USERNAME_INVALID',
      `a username is 1-${USERNAME_MAX} characters, no control characters or edge spaces`,
    );
  return u;
}

/** A password is 15–1024 characters after NFKC normalisation. */
export function checkPassword(p) {
  if (typeof p !== 'string')
    throw new ConsoleLoginError('UI_PASSWORD_INVALID', 'a password is text');
  const n = p.normalize('NFKC');
  if (n.length < PASSWORD_MIN || n.length > PASSWORD_MAX)
    throw new ConsoleLoginError(
      'UI_PASSWORD_INVALID',
      `a password is ${PASSWORD_MIN}-${PASSWORD_MAX} characters`,
    );
  return n;
}

const derive = (password, salt, params) =>
  new Promise((resolve, reject) =>
    scrypt(
      Buffer.from(password.normalize('NFKC')),
      salt,
      params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM },
      (e, key) => (e ? reject(e) : resolve(key)),
    ),
  );

/** Hash and store the credential in an owner-only file under the Sakk home. */
export async function setConsoleLogin({ home, username, password }) {
  checkUsername(username);
  const pw = checkPassword(password);
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(pw, salt, SCRYPT_PARAMS);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = loginPath(home);
  const record = {
    v: 1,
    username,
    salt: salt.toString('hex'),
    hash: hash.toString('hex'),
    params: { ...SCRYPT_PARAMS },
  };
  writeFileAtomic(path, JSON.stringify(record, null, 1) + '\n', 0o600);
  return { path };
}

/** Remove the credential; the console is token-only again from its next start. */
export function clearConsoleLogin({ home }) {
  const path = loginPath(home);
  let existed = true;
  try {
    lstatSync(path);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    existed = false;
  }
  rmSync(path, { force: true });
  return { path, removed: existed };
}

const unsafe = (path, why) =>
  new ConsoleLoginError(
    'CONSOLE_LOGIN_UNSAFE',
    `${path} ${why} — fix it or run sakk ui --clear-password, then start again`,
  );

/**
 * The stored credential, or null when sign-in is off (no file). A file that
 * exists but cannot be trusted (a link, shared, someone else's, malformed)
 * refuses the start rather than falling back to token-only silently.
 */
export function loadConsoleLogin({ home }) {
  const path = loginPath(home);
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new ConsoleLoginError('CONSOLE_LOGIN_UNREADABLE', `${path}: ${e.message}`);
  }
  if (st.isSymbolicLink()) throw unsafe(path, 'is a symlink');
  let fd;
  try {
    fd = openSync(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0));
  } catch (e) {
    throw new ConsoleLoginError('CONSOLE_LOGIN_UNREADABLE', `${path}: ${e.message}`);
  }
  let text;
  try {
    const f = fstatSync(fd);
    if (!f.isFile()) throw unsafe(path, 'is not a regular file');
    if (f.nlink !== 1) throw unsafe(path, 'has more than one name (a hard link)');
    if ((f.mode & 0o077) !== 0) throw unsafe(path, 'is readable or writable by others (want 0600)');
    if (typeof process.getuid === 'function' && f.uid !== process.getuid())
      throw unsafe(path, 'belongs to another user');
    if (f.size > FILE_CAP) throw unsafe(path, `is over ${FILE_CAP} bytes`);
    const buf = Buffer.alloc(FILE_CAP + 1);
    let n = 0;
    for (;;) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r <= 0) break;
      n += r;
      if (n > FILE_CAP) throw unsafe(path, `is over ${FILE_CAP} bytes`);
    }
    text = buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
  const bad = () =>
    new ConsoleLoginError(
      'CONSOLE_LOGIN_INVALID',
      `${path} is not a credential sakk ui --set-password wrote — run it again`,
    );
  let rec;
  try {
    rec = JSON.parse(text);
  } catch {
    throw bad();
  }
  const p = rec?.params;
  if (
    rec?.v !== 1 ||
    typeof rec.salt !== 'string' ||
    !/^[0-9a-f]{32}$/.test(rec.salt) ||
    typeof rec.hash !== 'string' ||
    !/^[0-9a-f]{128}$/.test(rec.hash) ||
    !p ||
    Object.keys(SCRYPT_PARAMS).some((k) => p[k] !== SCRYPT_PARAMS[k])
  )
    throw bad();
  try {
    checkUsername(rec.username);
  } catch {
    throw bad();
  }
  return {
    username: rec.username,
    salt: Buffer.from(rec.salt, 'hex'),
    hash: Buffer.from(rec.hash, 'hex'),
    params: { ...SCRYPT_PARAMS },
  };
}

const digest = (s) => createHash('sha256').update(String(s), 'utf8').digest();

/**
 * Constant-time check of a username and password: the scrypt runs for a wrong
 * username too, and both comparisons are fixed-length, so a wrong user and a
 * wrong password take the same path and get the same answer.
 */
export async function verifyConsoleLogin(rec, username, password) {
  const userOk = timingSafeEqual(digest(username), digest(rec.username));
  const key = await derive(String(password), rec.salt, rec.params);
  const passOk = timingSafeEqual(key, rec.hash);
  return userOk && passOk;
}

/**
 * Sessions and the failed-sign-in limit for one console run, all in memory.
 * `now` and `verify` are injectable so the limits are tested by counting,
 * not by waiting on scrypt or the clock.
 */
export function createLoginGate({
  rec,
  now = Date.now,
  log = () => {},
  verify = verifyConsoleLogin,
}) {
  const sessions = new Map(); // sha256(id) → { created, seen }
  let failures = []; // times of failed (or in-flight) attempts in the window
  let busy = false;
  const key = (id) => digest(id).toString('hex');
  const prune = (t) => {
    failures = failures.filter((f) => t - f < LOGIN_WINDOW_MS);
  };
  return {
    /** True for a live session id this run issued; refreshes its idle clock. */
    sessionOk(id) {
      if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) return false;
      const k = key(id);
      const s = sessions.get(k);
      if (!s) return false;
      const t = now();
      if (t - s.created >= SESSION_MAX_MS || t - s.seen >= SESSION_IDLE_MS) {
        sessions.delete(k);
        return false;
      }
      s.seen = t;
      return true;
    },
    end(id) {
      if (typeof id === 'string') sessions.delete(key(id));
    },
    get sessions() {
      return sessions.size;
    },
    get failures() {
      prune(now());
      return failures.length;
    },
    async signIn(username, password) {
      const t = now();
      prune(t);
      if (failures.length >= LOGIN_MAX_FAILURES) {
        const retryAfter = Math.max(1, Math.ceil((failures[0] + LOGIN_WINDOW_MS - t) / 1000));
        log(`sign-in refused: locked for ${retryAfter}s after ${LOGIN_MAX_FAILURES} failures`);
        return { locked: true, retryAfter };
      }
      if (busy) return { busy: true };
      busy = true;
      failures.push(t); // the slot is taken before the check, so a burst cannot overrun
      let ok = false;
      try {
        ok = await verify(rec, username, password);
      } finally {
        busy = false;
      }
      if (!ok) {
        prune(now());
        log(
          `sign-in failed (${failures.length} of ${LOGIN_MAX_FAILURES} in ${LOGIN_WINDOW_MS / 60000} min)`,
        );
        return { ok: false };
      }
      failures.splice(failures.indexOf(t), 1);
      const id = randomBytes(16).toString('hex'); // 128-bit, fresh per sign-in
      const at = now();
      sessions.set(key(id), { created: at, seen: at });
      while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      return { ok: true, id };
    },
  };
}

const needsTty = () =>
  new ConsoleLoginError(
    'UI_PASSWORD_NEEDS_TTY',
    'set the password at a terminal: sakk ui --set-password asks for it and does not echo it',
  );
const isTerminal = (input) => Boolean(input.isTTY) && typeof input.setRawMode === 'function';

/** One visible line (the username), echoed by the terminal itself. */
const askLine = ({ input, output, prompt }) =>
  new Promise((resolve) => {
    const rl = createInterface({ input, output, terminal: false });
    rl.question(prompt, (a) => {
      rl.close();
      resolve(a.slice(0, USERNAME_MAX + 1));
    });
  });

/**
 * `sakk ui --set-password`: a person at a terminal types a username, then the
 * password twice without echo. Nothing is saved unless the two match.
 */
export async function askConsoleLogin({ home, input = process.stdin, output = process.stderr }) {
  if (!isTerminal(input)) throw needsTty();
  const username = checkUsername(await askLine({ input, output, prompt: 'Console username: ' }));
  const password = checkPassword(
    await promptHidden({
      input,
      output,
      prompt: `Password (${PASSWORD_MIN} or more characters, not shown): `,
    }),
  );
  const again = await promptHidden({ input, output, prompt: 'The same password again: ' });
  if (again.normalize('NFKC') !== password)
    throw new ConsoleLoginError(
      'UI_PASSWORD_MISMATCH',
      'the two passwords differ; nothing was saved',
    );
  return { ...(await setConsoleLogin({ home, username, password })), username };
}

/**
 * Read one line from a terminal without echoing it. Refuses anything that is
 * not a TTY, so a password is never piped in, logged or put on argv.
 */
export function promptHidden({ input = process.stdin, output = process.stderr, prompt }) {
  if (!isTerminal(input)) return Promise.reject(needsTty());
  return new Promise((resolve, reject) => {
    let buf = '';
    output.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const done = (err, value) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      output.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(null, buf);
        if (ch === '\u0003' || ch === '\u0004')
          return done(new ConsoleLoginError('UI_PASSWORD_CANCELLED', 'cancelled'));
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else if (buf.length <= PASSWORD_MAX) buf += ch;
      }
    };
    input.on('data', onData);
  });
}
