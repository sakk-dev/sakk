#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// DCO check (CONTRIBUTING.md): every commit in a range, merges aside, carries
// a `Signed-off-by: Name <email>` trailer whose email is the commit's author
// email (case aside). A sign-off is the contributor's statement under the
// Developer Certificate of Origin 1.1 — not a verified identity, and not a
// cryptographic signature.
//
//   node scripts/dco-check.mjs --range <base>..<head>
//
// Runs git in the current directory. Exit 0: every commit has one. Exit 1:
// some do not, each named with why and the fix. Exit 2: it cannot check (no
// or malformed range, an unknown revision, an empty range, git failing or a
// log past the byte cap). CI runs the base branch's copy, so a pull request
// cannot loosen the check that judges it.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Past this many bytes of git log the check refuses instead of reading on. */
export const MAX_LOG_BYTES = 32 * 1024 * 1024;
const FS = '\x1f';
const SIGN_OFF = /^Signed-off-by:[ \t]*(.*?)[ \t]*<([^<>\s]+)>[ \t]*$/gim;

/** The sign-off trailers in a commit message, as { name, email }. */
export function signOffs(message) {
  return [...String(message).replace(/\r/g, '').matchAll(SIGN_OFF)].map((m) => ({
    name: m[1],
    email: m[2],
  }));
}

/** Why one commit fails the check, or null when it passes. */
export function problem({ email, message }) {
  const author = String(email ?? '').trim();
  if (!author) return 'its author has no email to match a sign-off against';
  const offs = signOffs(message);
  if (!offs.length) return 'no Signed-off-by trailer';
  if (offs.some((s) => s.email.toLowerCase() === author.toLowerCase())) return null;
  return `signed off by ${offs.map((s) => `<${s.email}>`).join(', ')}, not by its author <${author}>`;
}

class CannotCheck extends Error {}

const git = (args) => {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: MAX_LOG_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (e.code === 'ENOBUFS')
      throw new CannotCheck(`git log is over ${MAX_LOG_BYTES} bytes — narrow the range`);
    throw new CannotCheck(`git ${args[0]} failed: ${String(e.stderr || e.message).trim()}`);
  }
};

/** The commits of `range` as { sha, parents, name, email, message }. */
export function commits(range) {
  const text = String(range ?? '');
  const m = /^([^\s.-]\S*?)\.\.([^\s.-]\S*)$/.exec(text);
  if (!m || text.includes('...')) throw new CannotCheck(`not a <base>..<head> range: ${range}`);
  for (const rev of [m[1], m[2]]) {
    try {
      git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
    } catch {
      throw new CannotCheck(`unknown revision: ${rev}`);
    }
  }
  // -z: records end in NUL, which a commit message cannot hold
  const out = git(['log', '-z', `--format=%H${FS}%P${FS}%an${FS}%ae${FS}%B`, range, '--']);
  const list = out
    .split('\0')
    .filter((r) => r.trim())
    .map((r) => {
      const [sha, parents, name, email, ...rest] = r.split(FS);
      return {
        sha,
        parents: parents.split(' ').filter(Boolean),
        name,
        email,
        message: rest.join(FS),
      };
    });
  if (!list.length) throw new CannotCheck(`the range ${range} holds no commit`);
  return list;
}

/** { code, lines } for one run over `range`. */
export function check(range) {
  let list;
  try {
    list = commits(range);
  } catch (e) {
    if (e instanceof CannotCheck) return { code: 2, lines: [`dco: cannot check — ${e.message}`] };
    throw e;
  }
  const own = list.filter((c) => c.parents.length <= 1);
  const bad = own.map((c) => ({ c, why: problem(c) })).filter((x) => x.why);
  const merges = list.length - own.length;
  const skipped = merges ? ` (${merges} merge commit${merges > 1 ? 's' : ''} skipped)` : '';
  if (!bad.length)
    return {
      code: 0,
      lines: [`dco: ${own.length} commit(s) signed off by their authors${skipped}`],
    };
  const base = range.split('..')[0];
  return {
    code: 1,
    lines: [
      `dco: ${bad.length} of ${own.length} commit(s) lack a sign-off by their author${skipped}:`,
      ...bad.map(({ c, why }) => `  ${c.sha.slice(0, 12)} ${c.message.split('\n')[0]} — ${why}`),
      `fix: git rebase --signoff ${base}  (adds "Signed-off-by: <your name> <your email>" to each), then push with --force-with-lease`,
      'see CONTRIBUTING.md: the sign-off states the Developer Certificate of Origin 1.1',
    ],
  };
}

function main(argv) {
  const at = argv.indexOf('--range');
  const range = at >= 0 ? argv[at + 1] : undefined;
  if (!range) {
    console.error('usage: node scripts/dco-check.mjs --range <base>..<head>');
    return 2;
  }
  const { code, lines } = check(range);
  (code === 0 ? console.log : console.error)(lines.join('\n'));
  return code;
}

const self = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (self) process.exitCode = main(process.argv.slice(2));
