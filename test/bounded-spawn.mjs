// Loaded before every test file (`node --test --import ./test/bounded-spawn.mjs`).
//
// F-143 (C-04): a synchronous child blocks the test process's event loop, so
// `--test-timeout` cannot fire while it runs — one hung child once held a
// local run for twenty minutes with no diagnosis. Every spawnSync,
// execFileSync and execSync a test makes therefore carries a time bound: its
// own `timeout` if it sets one, this default if it does not. A child killed
// by the default says so on stderr, so the failure names its cause.

import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const fromEnv = Number(process.env.SAKK_TEST_SPAWN_TIMEOUT_MS);
/** Below the 300 s per-test timeout, above the slowest legitimate child. */
export const DEFAULT_SPAWN_TIMEOUT_MS = fromEnv > 0 ? fromEnv : 240_000;

const isOptions = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function bounded(name, original) {
  return function (...args) {
    const last = args.at(-1);
    const hasOptions = args.length > 1 && isOptions(last);
    const options = hasOptions ? last : {};
    if (options.timeout !== undefined) return original.apply(this, args);
    const withBound = { ...options, timeout: DEFAULT_SPAWN_TIMEOUT_MS, killSignal: 'SIGKILL' };
    const call = hasOptions ? [...args.slice(0, -1), withBound] : [...args, withBound];
    const say = () =>
      process.stderr.write(
        `bounded-spawn: ${name}(${String(args[0])}) killed after ${DEFAULT_SPAWN_TIMEOUT_MS} ms (F-143)\n`,
      );
    try {
      const r = original.apply(this, call);
      if (r?.error?.code === 'ETIMEDOUT') say();
      return r;
    } catch (e) {
      if (e?.code === 'ETIMEDOUT') say();
      throw e;
    }
  };
}

for (const name of ['spawnSync', 'execFileSync', 'execSync']) cp[name] = bounded(name, cp[name]);
syncBuiltinESMExports();
