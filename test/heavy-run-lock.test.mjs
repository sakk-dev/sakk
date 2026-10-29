import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * F-220 (C-09): two heavy runs at once on one machine starve each other's
 * tests, so a guard that passes alone in under a second was killed at its
 * 240 s spawn bound while a drill ran beside the gate. Every heavy entry point
 * (gate, drill, audit, certificate, pre-push suite) takes one machine-wide
 * lock and refuses while another run holds it. The scripts run here as they
 * ship, in a throwaway folder whose npm scripts only log that they ran. The
 * pre-push hook's case is in pre-push.test.mjs.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_MODULE = join(REPO, 'scripts', 'heavy-lock.mjs');
const BASE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) =>
      !k.startsWith('GIT_') &&
      !['SAKK_HEAVY_LOCK', 'SAKK_HEAVY_LOCK_PID', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS'].includes(k),
  ),
);
const STEPS = ['brief', 'lint', 'format:check', 'test', 'test:eval'];

/** A throwaway copy of the given scripts, a lock path of its own, and a probe log. */
function fixture(t, scripts = []) {
  const root = mkdtempSync(join(tmpdir(), 'heavy-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'home'));
  if (existsSync(LOCK_MODULE)) copyFileSync(LOCK_MODULE, join(root, 'scripts', 'heavy-lock.mjs'));
  for (const s of scripts) copyFileSync(join(REPO, 'scripts', s), join(root, 'scripts', s));
  const lock = join(root, 'heavy.lock');
  const probe = join(root, 'probe.log');
  // each npm step logs its name, the lock pid it was given and whether the lock was held
  writeFileSync(
    join(root, 'probe.cjs'),
    `const fs = require('fs');
     fs.appendFileSync(${JSON.stringify(probe)}, JSON.stringify({
       step: process.argv[2],
       pid: process.env.SAKK_HEAVY_LOCK_PID ?? null,
       held: fs.existsSync(${JSON.stringify(lock)}),
     }) + '\\n');
     const fail = fs.existsSync(${JSON.stringify(join(root, 'fail'))}) &&
       fs.readFileSync(${JSON.stringify(join(root, 'fail'))}, 'utf8') === process.argv[2];
     process.exit(fail ? 1 : 0);`,
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'throwaway',
      private: true,
      scripts: Object.fromEntries(STEPS.map((s) => [s, `node probe.cjs ${s}`])),
    }),
  );
  const env = {
    ...BASE_ENV,
    HOME: join(root, 'home'),
    SAKK_HEAVY_LOCK: lock,
    npm_config_cache: join(root, 'npm-cache'),
    npm_config_update_notifier: 'false',
  };
  return {
    root,
    lock,
    env,
    run: (cmd, args, extra = {}) =>
      spawnSync(cmd, args, {
        cwd: root,
        env: { ...env, ...extra },
        encoding: 'utf8',
        timeout: 120_000,
      }),
    plant(pid, what = 'mutation drill in /elsewhere') {
      mkdirSync(lock);
      writeFileSync(join(lock, 'owner'), `${pid} 2026-10-29T00:00:00.000Z ${what}\n`);
    },
    probes: () =>
      existsSync(probe)
        ? readFileSync(probe, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [],
    fail: (step) => writeFileSync(join(root, 'fail'), step),
  };
}

/** A pid that no process has any more: a child that ran and was reaped. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

/** A live process other than this one, killed when the test ends. */
function sleeper(t) {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => c.kill('SIGKILL'));
  return c.pid;
}

describe('C-09: one heavy run at a time on this machine (F-220)', () => {
  test('the gate refuses to start while another heavy run holds the machine-wide lock, and runs nothing (F-220)', (t) => {
    const f = fixture(t, ['gate.sh']);
    f.plant(process.pid);
    const r = f.run('bash', ['scripts/gate.sh']);
    assert.notEqual(r.status, 0, `the gate ran beside a live holder:\n${r.stdout}${r.stderr}`);
    assert.deepEqual(f.probes(), [], 'no step may start while another run holds the lock');
    assert.match(r.stderr, /heavy-lock: refused gate in /);
    assert.match(
      r.stderr,
      new RegExp(`mutation drill in /elsewhere \\(pid ${process.pid}, since `),
    );
    // the holder's lock is untouched
    assert.match(readFileSync(join(f.lock, 'owner'), 'utf8'), new RegExp(`^${process.pid} `));
  });

  test('a free lock: every gate step runs inside it, and the gate releases it, green or red', (t) => {
    const f = fixture(t, ['gate.sh']);
    let r = f.run('bash', ['scripts/gate.sh']);
    assert.equal(r.status, 0, r.stderr);
    const steps = f.probes();
    assert.deepEqual(
      steps.map((p) => p.step),
      STEPS,
    );
    assert.ok(
      steps.every((p) => p.held && p.pid === steps[0].pid && /^[1-9]\d*$/.test(p.pid)),
      JSON.stringify(steps),
    );
    assert.equal(existsSync(f.lock), false, 'a green gate releases the lock');

    f.fail('lint');
    r = f.run('bash', ['scripts/gate.sh']);
    assert.notEqual(r.status, 0);
    assert.equal(existsSync(f.lock), false, 'a red gate releases the lock too');
  });

  test('a lock left by a run that is gone (killed with SIGKILL) is taken over', async (t) => {
    const f = fixture(t, ['gate.sh']);
    const run = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    t.after(() => run.kill('SIGKILL'));
    const took = f.run(process.execPath, [
      'scripts/heavy-lock.mjs',
      'acquire',
      'gate in /crashed',
      String(run.pid),
    ]);
    assert.equal(took.stdout.trim(), String(run.pid), took.stderr);
    // the control: while that run lives, the gate is refused
    assert.notEqual(f.run('bash', ['scripts/gate.sh']).status, 0);
    assert.deepEqual(f.probes(), []);
    // SIGKILL runs no exit trap, so the lock stays behind
    await new Promise((done) => {
      run.on('exit', done);
      run.kill('SIGKILL');
    });
    assert.match(readFileSync(join(f.lock, 'owner'), 'utf8'), new RegExp(`^${run.pid} `));
    const r = f.run('bash', ['scripts/gate.sh']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.probes().length, STEPS.length);
    assert.equal(existsSync(f.lock), false);
    // a pid that never ran a lock holder is the same case
    f.plant(deadPid());
    assert.equal(f.run('bash', ['scripts/gate.sh']).status, 0);
  });

  test('the drill refuses before it resets its report', (t) => {
    const f = fixture(t, ['mutation-drill.sh']);
    const report = join(f.root, 'report.txt');
    writeFileSync(report, 'the last drill report\n');
    f.plant(process.pid);
    const r = f.run('sh', ['scripts/mutation-drill.sh', report]);
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /heavy-lock: refused mutation drill in /);
    assert.equal(readFileSync(report, 'utf8'), 'the last drill report\n');
  });

  test('the audit refuses before it starts a step or writes a log', (t) => {
    const f = fixture(t, ['audit.mjs']);
    writeFileSync(join(f.root, 'scripts', 'findings-inbox.mjs'), 'export function addItem() {}\n');
    f.plant(process.pid);
    const r = f.run(process.execPath, ['scripts/audit.mjs']);
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /heavy-lock: refused npm run audit/);
    assert.equal(existsSync(join(f.root, 'audit-logs')), false);
    assert.deepEqual(f.probes(), []);
  });

  test('the certificate refuses with CERT_LOCKED and its refusal exit code', (t) => {
    const f = fixture(t, ['gate-certificate.mjs']);
    writeFileSync(join(f.root, 'CERTIFICATE.md'), 'a stale certificate\n');
    f.plant(process.pid);
    const r = f.run(process.execPath, ['scripts/gate-certificate.mjs']);
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^CERT_LOCKED: heavy-lock: refused npm run certificate/m);
    assert.equal(existsSync(join(f.root, 'CERTIFICATE.md')), false);
  });

  test('a run inside the holder (the drill inside the audit) runs in its lock and leaves it held', async (t) => {
    const { acquire, release, LOCK_ENV } = await import(pathToFileURL(LOCK_MODULE).href);
    const f = fixture(t);
    const outer = sleeper(t);
    f.plant(outer, 'audit in /repo');
    const inside = acquire('mutation drill', process.pid, { ...f.env, [LOCK_ENV]: String(outer) });
    assert.deepEqual(
      { ok: inside.ok, owner: inside.owner, nested: inside.nested },
      { ok: true, owner: outer, nested: true },
    );
    assert.equal(release(process.pid, f.env), false);
    assert.match(readFileSync(join(f.lock, 'owner'), 'utf8'), new RegExp(`^${outer} `));
    // without the holder's pid in its environment the same run is refused
    const outside = acquire('mutation drill', process.pid, f.env);
    assert.equal(outside.ok, false);
    assert.equal(outside.holder.pid, outer);
  });

  test('only the holder releases; a lock nobody can read is taken over', async (t) => {
    const { acquire, release } = await import(pathToFileURL(LOCK_MODULE).href);
    const f = fixture(t);
    const other = sleeper(t);
    f.plant(other);
    assert.equal(release(process.pid, f.env), false);
    assert.ok(existsSync(f.lock));
    rmSync(f.lock, { recursive: true });
    mkdirSync(f.lock); // a lock directory with no owner file
    const r = acquire('gate', process.pid, f.env);
    assert.deepEqual([r.ok, r.nested], [true, false]);
    assert.equal(release(process.pid, f.env), true);
    assert.equal(existsSync(f.lock), false);
  });

  test('of many runs that start at once, exactly one takes the lock', async (t) => {
    const f = fixture(t);
    const owners = Array.from({ length: 8 }, () => sleeper(t));
    const results = await Promise.all(
      owners.map(
        (pid, i) =>
          new Promise((done) => {
            const c = spawn(
              process.execPath,
              ['scripts/heavy-lock.mjs', 'acquire', `racer ${i}`, String(pid)],
              { cwd: f.root, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] },
            );
            let out = '';
            c.stdout.on('data', (d) => (out += d));
            c.on('close', (code) => done({ pid, code, out: out.trim() }));
          }),
      ),
    );
    const won = results.filter((r) => r.code === 0);
    assert.equal(won.length, 1, JSON.stringify(results));
    assert.equal(won[0].out, String(won[0].pid));
    assert.ok(
      results.every((r) => r.code === 0 || r.code === 1),
      JSON.stringify(results),
    );
    assert.match(readFileSync(join(f.lock, 'owner'), 'utf8'), new RegExp(`^${won[0].pid} `));
  });

  test('the command line refuses a malformed call with the usage exit code', (t) => {
    const f = fixture(t);
    for (const args of [
      [],
      ['acquire', 'gate'],
      ['acquire', ' ', '123'],
      ['acquire', 'gate', 'x'],
      ['release'],
    ]) {
      const r = f.run(process.execPath, ['scripts/heavy-lock.mjs', ...args]);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, /usage: heavy-lock\.mjs/);
    }
    assert.equal(existsSync(f.lock), false);
  });
});
