// Run the real CLI under a pseudo-terminal and answer its confirmation prompt,
// the way a person at a terminal would (F-171). Node has no pty of its own, so
// python3's pty module drives it; without python3 the tests that need it skip.

import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sakk.mjs');

const DRIVER = `
import json, os, pty, select, sys
argv, answer = json.loads(sys.argv[1]), sys.argv[2]
pid, fd = pty.fork()
if pid == 0:
    os.execv(argv[0], argv)
out, sent = b'', False
while True:
    ready, _, _ = select.select([fd], [], [], 20)
    if not ready:
        break
    try:
        data = os.read(fd, 4096)
    except OSError:
        break
    if not data:
        break
    out += data
    if not sent and b'to go ahead: ' in out:
        os.write(fd, (answer + '\\n').encode())
        sent = True
_, status = os.waitpid(pid, 0)
print(json.dumps({'status': os.waitstatus_to_exitcode(status), 'out': out.decode('utf8', 'replace'), 'asked': sent}))
`;

/** True when python3 with its pty module can run here. */
export const HAS_PTY =
  process.platform !== 'win32' &&
  spawnSync('python3', ['-c', 'import pty'], { timeout: 10_000 }).status === 0;

/**
 * `sakk <args>` at a terminal, answering the prompt with `answer`.
 * Returns { status, out (the terminal's text), asked (whether a prompt came) }.
 */
export function atTerminal(args, answer, { env, cwd }) {
  const r = spawnSync(
    'python3',
    ['-c', DRIVER, JSON.stringify([process.execPath, CLI, ...args]), answer],
    { env, cwd, encoding: 'utf8', timeout: 60_000 },
  );
  if (r.status !== 0) throw new Error(`pty driver failed: ${r.stderr || r.error}`);
  return JSON.parse(r.stdout);
}
