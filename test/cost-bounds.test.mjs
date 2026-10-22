import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Class detector for C-04 (unbounded or clock-judged cost; F-105, F-107).
 * Every function a source module exports must show how its work is bounded
 * on attacker-shaped input — by a refusal it emits above a limit, or by the
 * bounded caller it is only reached through. The proof is a refusal code,
 * never a stopwatch (F-62). A new export with no entry here fails the suite.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = readdirSync(join(ROOT, 'src')).filter((f) => f.endsWith('.mjs'));
const tmp = () => mkdtempSync(join(tmpdir(), 'cost-bounds-'));
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return 'NO_REFUSAL';
};
const long = (n) => 'x'.repeat(n);
const META_TEST = 'every exported function shows how its work is bounded';
/**
 * A guard resolves only to a real `test('<name>'`/`"<name>"`/`` `<name>` ``
 * declaration, never merely a string that appears in the file, and never the
 * meta-test above — a guard that points at the listing that requires it is
 * circular and can never fail (F-150 detector gap).
 */
const resolves = (ref) => {
  const [p, name] = ref.split('::');
  if (!existsSync(join(ROOT, p))) return false;
  if (name === META_TEST) return false;
  const text = readFileSync(join(ROOT, p), 'utf8');
  return [`test('${name}'`, `test("${name}"`, `test(\`${name}\``].some((d) => text.includes(d));
};

const ledger = await import(pathToFileURL(join(ROOT, 'src', 'ledger.mjs')));
const policy = await import(pathToFileURL(join(ROOT, 'src', 'policy.mjs')));
const classify = await import(pathToFileURL(join(ROOT, 'src', 'classify.mjs')));
const hookMod = await import(pathToFileURL(join(ROOT, 'src', 'hook.mjs')));
const { LIMITS } = ledger;
const FINDINGS = JSON.parse(readFileSync(join(ROOT, 'findings', 'ledger.json'), 'utf8')).findings;
const fresh = () => {
  const ledgerPath = join(tmp(), 'ledger.json');
  ledger.initLedger({ ledgerPath, capUsd: 100 });
  return ledgerPath;
};

/**
 * One entry per exported function: `refuses` runs the attacker-shaped call
 * and names the code it must end in; `bounded` names the bounded caller and
 * a test that holds that bound; `debt` names the open finding that owes the
 * bound — the entry fails once that finding is closed, so it cannot outlive it.
 */
const BOUNDS = {
  'ledger.mjs': {
    reserve: {
      refuses: () =>
        code(() =>
          ledger.reserve({
            ledgerPath: fresh(),
            callId: long(LIMITS.idChars + 1),
            estimatedMaxUsd: 1,
          }),
        ),
      expect: 'INPUT_TOO_LONG',
    },
    settle: {
      // settle stores no new id (a long one must still settle, F-150); what it
      // stores and bounds is the caller's tokens blob
      refuses: () => {
        const lp = fresh();
        ledger.reserve({ ledgerPath: lp, callId: 'c', estimatedMaxUsd: 1 });
        return code(() =>
          ledger.settle({
            ledgerPath: lp,
            callId: 'c',
            actualUsd: 1,
            tokens: { blob: long(LIMITS.tokensBytes) },
          }),
        );
      },
      expect: 'INPUT_TOO_LONG',
    },
    halt: {
      refuses: () =>
        code(() => ledger.halt({ ledgerPath: fresh(), by: long(LIMITS.nameChars + 1) })),
      expect: 'INPUT_TOO_LONG',
    },
    resume: {
      refuses: () =>
        code(() => ledger.resume({ ledgerPath: fresh(), by: long(LIMITS.nameChars + 1) })),
      expect: 'INPUT_TOO_LONG',
    },
    clearReconciliation: {
      refuses: () =>
        code(() =>
          ledger.clearReconciliation({ ledgerPath: fresh(), by: long(LIMITS.nameChars + 1) }),
        ),
      expect: 'INPUT_TOO_LONG',
    },
    forceUnlock: {
      refuses: () =>
        code(() => ledger.forceUnlock({ ledgerPath: fresh(), by: long(LIMITS.nameChars + 1) })),
      expect: 'INPUT_TOO_LONG',
    },
    initLedger: {
      refuses: () =>
        code(() =>
          ledger.initLedger({
            ledgerPath: join(tmp(), 'l.json'),
            capUsd: 1,
            initializedBy: long(LIMITS.nameChars + 1),
          }),
        ),
      expect: 'INPUT_TOO_LONG',
    },
    readLedger: {
      debt: 'F-105',
      bounded:
        'one read of the whole file, which grows with use until the archive keeps the live books small',
    },
    markReconciliationRequired: {
      bounded: 'stores a reason bounded by truncation (boundReason), whatever length it is given',
      guard:
        'test/cost-bounds.test.mjs::a huge reconciliation reason is stored truncated, not whole',
    },
    totalsOf: {
      debt: 'F-105',
      bounded: 'a sum over the entries readLedger returned, whose count grows with use',
    },
    maxReservableUsd: {
      bounded: 'arithmetic on the totals totalsOf returned; no attacker-sized input',
      guard: 'test/cost-bounds.test.mjs::max reservable is 0 when the headroom is below the floor',
    },
    defaultLedgerPath: {
      bounded: 'reads one environment variable; no attacker-sized input',
      guard: 'test/cost-bounds.test.mjs::defaultLedgerPath reads only the environment',
    },
  },
  'classify.mjs': {
    shellActions: {
      refuses: () => code(() => classify.shellActions('x'.repeat(classify.MAX_COMMAND + 1), '/')),
      expect: 'HOOK_INPUT_TOO_LARGE',
    },
    patchActions: {
      refuses: () =>
        code(() => classify.patchActions('x'.repeat(8 * classify.MAX_COMMAND + 1), '/')),
      expect: 'HOOK_INPUT_TOO_LARGE',
    },
    shellSegments: {
      bounded:
        "linear in the text; reached only through shellActions and the loop's classifyShell, both capped at 64 KiB",
      guard: 'test/guard.test.mjs::every malformed payload is a deny with a code',
    },
    realOf: {
      bounded: 'one path from a payload already capped at 1 MiB; walks up its own parents only',
      guard: 'test/guard.test.mjs::every malformed payload is a deny with a code',
    },
    scopeOf: {
      bounded:
        "one path from a payload already capped at 1 MiB; the scope then meets decide()'s 4096-character cap",
      guard: 'test/guard.test.mjs::every malformed payload is a deny with a code',
    },
    toDecisions: {
      bounded: 'one entry per action of a command already capped at 64 KiB',
      guard: 'test/guard.test.mjs::every malformed payload is a deny with a code',
    },
    isSecretPath: {
      bounded: 'one anchored pattern over a file name',
      guard: 'test/guard.test.mjs::every malformed payload is a deny with a code',
    },
  },
  'hook.mjs': {
    runHook: {
      refuses: () =>
        /HOOK_INPUT_TOO_LARGE/.test(
          hookMod.runHook('claude-code', 'x'.repeat(hookMod.MAX_PAYLOAD + 1)),
        )
          ? 'HOOK_INPUT_TOO_LARGE'
          : 'NO_REFUSAL',
      expect: 'HOOK_INPUT_TOO_LARGE',
    },
    normalize: {
      bounded: 'reads fields of a payload runHook capped at 1 MiB',
      guard: 'test/guard.test.mjs::every malformed payload is a deny with a code',
    },
    actionsOf: {
      bounded: 'classifies a command capped at 64 KiB or a patch capped at 512 KiB',
      guard: 'test/guard.test.mjs::every malformed payload is a deny with a code',
    },
    evaluate: {
      bounded: 'one decide() per action, an internal deadline of 2 s, and a policy capped at 4 MiB',
      guard: 'test/guard.test.mjs::the hook answers deny at its own deadline',
    },
    answer: {
      bounded: 'formats one reason built from bounded fields',
      guard: 'test/guard.test.mjs::every malformed payload is a deny with a code',
    },
    haltFor: {
      bounded: 'reads the ledger through readLedger (F-105 debt: the books grow with use)',
      guard:
        'test/cost-bounds.test.mjs::the books growing with use is owed by F-105 while it is open',
    },
    choosePolicy: {
      bounded:
        'loads at most two policies through loadPolicy, which refuses a file over 4 MiB, and copies one of them',
      guard:
        'test/guard.test.mjs::a broken project policy gives way to the last one that loaded, and says so',
    },
    goodPolicyPaths: {
      bounded: 'one realpath and one hash of the repository path, which the hook already bounds',
      guard:
        'test/guard.test.mjs::a broken project policy gives way to the last one that loaded, and says so',
    },
    readConfig: {
      bounded: "reads Sakk's own config file, written by sakk commands, not by the agent",
      guard: 'test/guard.test.mjs::every malformed payload is a deny with a code',
    },
    repoRootOf: {
      bounded: 'one git rev-parse call',
      guard: 'test/guard.test.mjs::every malformed payload is a deny with a code',
    },
    sakkHome: {
      bounded: 'reads two environment variables',
      guard: 'test/guard.test.mjs::every malformed payload is a deny with a code',
    },
  },
  'guard-install.mjs': {
    hookCommand: {
      bounded: "run by a person against the agent's own config file, never on the hook path",
      guard: 'test/guard.test.mjs::install merges, repeats cleanly and uninstalls only itself',
    },
    configPath: {
      bounded: "run by a person against the agent's own config file, never on the hook path",
      guard: 'test/guard.test.mjs::install merges, repeats cleanly and uninstalls only itself',
    },
    claudeSupportsOnFailure: {
      bounded: "run by a person against the agent's own config file, never on the hook path",
      guard: 'test/guard.test.mjs::install merges, repeats cleanly and uninstalls only itself',
    },
    withGuard: {
      bounded: "run by a person against the agent's own config file, never on the hook path",
      guard: 'test/guard.test.mjs::install merges, repeats cleanly and uninstalls only itself',
    },
    withoutGuard: {
      bounded: "run by a person against the agent's own config file, never on the hook path",
      guard: 'test/guard.test.mjs::install merges, repeats cleanly and uninstalls only itself',
    },
    install: {
      bounded: "run by a person against the agent's own config file, never on the hook path",
      guard: 'test/guard.test.mjs::install merges, repeats cleanly and uninstalls only itself',
    },
    uninstall: {
      bounded: "run by a person against the agent's own config file, never on the hook path",
      guard: 'test/guard.test.mjs::install merges, repeats cleanly and uninstalls only itself',
    },
    firePayload: {
      bounded: "run by a person against the agent's own config file, never on the hook path",
      guard: 'test/guard.test.mjs::install merges, repeats cleanly and uninstalls only itself',
    },
    fire: {
      bounded: "run by a person against the agent's own config file, never on the hook path",
      guard: 'test/guard.test.mjs::install merges, repeats cleanly and uninstalls only itself',
    },
    doctor: {
      bounded: "run by a person against the agent's own config file, never on the hook path",
      guard: 'test/guard.test.mjs::install merges, repeats cleanly and uninstalls only itself',
    },
  },
  'policy.mjs': {
    loadPolicy: {
      refuses: () => {
        const p = join(tmp(), 'policy.json');
        writeFileSync(p, ' '.repeat(policy.MAX_POLICY_BYTES + 1));
        return code(() => policy.loadPolicy({ policyPath: p }));
      },
      expect: 'POLICY_TOO_LARGE',
    },
    decide: {
      refuses: () => {
        const p = join(tmp(), 'policy.json');
        writeFileSync(
          p,
          JSON.stringify({
            schema: 'sakk-policy.v1',
            default_verdict: 'deny',
            rules: [{ id: 'a', match: { action: 'x' }, verdict: 'allow' }],
          }),
        );
        const loaded = policy.loadPolicy({ policyPath: p });
        return code(() =>
          policy.decide({
            ...loaded,
            context: { action: long(4097), callId: 'c', estimatedUsd: 0 },
          }),
        );
      },
      expect: 'CONTEXT_INVALID',
    },
    matchPath: {
      bounded:
        're-exported from match.mjs; reached only through decide() and loadPolicy(), which bound their inputs',
      guard:
        'test/policy.test.mjs::N1 attack (verify pass): uncounted pre-filter spin — distinct-agent mega-policy refuses, never idles',
    },
    logDecision: {
      refuses: () =>
        code(() =>
          policy.logDecision({
            decisionLogPath: join(tmp(), 'd.jsonl'),
            decision: { verdict: 'deny', ruleId: null, policyHash: 'a'.repeat(64), context: {} },
            by: long(4097),
          }),
        ),
      expect: 'DECISION_UNLOGGABLE',
    },
  },
  'match.mjs': Object.fromEntries(
    ['matchPath', 'matchesAny', 'isCanonicalRelPath', 'prefixCovers'].map((f) => [
      f,
      {
        bounded:
          'reached only through decide() (context strings capped at 4096) and loadPolicy() (file capped, shadow scan budgeted)',
        guard:
          'test/policy.test.mjs::N1 attack (verify pass): uncounted pre-filter spin — distinct-agent mega-policy refuses, never idles',
      },
    ]),
  ),
  'secret-scan.mjs': {
    scanText: {
      bounded: 'every rule has bounded quantifiers, so a line costs linear work per rule',
      guard:
        'test/secret-scan.test.mjs::200KB adversarial lines for every rule scan without catastrophic backtracking',
    },
    scanPaths: {
      bounded:
        'files above MAX_SCAN_BYTES are refused before reading; each file goes through scanText',
      guard:
        'test/secret-scan.test.mjs::200KB adversarial lines for every rule scan without catastrophic backtracking',
    },
    scanStaged: {
      bounded: 'staged blobs above MAX_SCAN_BYTES are refused; each blob goes through scanText',
      guard:
        'test/secret-scan.test.mjs::200KB adversarial lines for every rule scan without catastrophic backtracking',
    },
    display: {
      bounded: 'formats one finding whose fields scanText produced from a bounded line',
      guard:
        'test/secret-scan.test.mjs::200KB adversarial lines for every rule scan without catastrophic backtracking',
    },
  },
  'append.mjs': {
    appendNoFollow: {
      bounded:
        'writes text its callers bounded (decision lines from decide(), alerts from the ledger)',
      guard:
        'test/policy.test.mjs::appends one JSONL line carrying verdict, ruleId, policyHash and context',
    },
  },
  'mcp.mjs': {
    startMcpServer: {
      bounded:
        'each frame is capped at 1 MiB and each string argument at 4096 characters before any work',
      guard: 'test/mcp.test.mjs::an oversized frame answers -32600 and the next call still works',
    },
  },
};

describe('C-04: every exported function is bounded on attacker-shaped input', () => {
  test('every exported function shows how its work is bounded', async () => {
    const missing = [];
    for (const f of SOURCES) {
      const mod = await import(pathToFileURL(join(ROOT, 'src', f)));
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value !== 'function' || /^[A-Z]/.test(name)) continue; // classes are errors, not work
        if (!BOUNDS[f]?.[name]) missing.push(`${f}:${name}`);
      }
    }
    assert.deepEqual(
      missing,
      [],
      'add each to BOUNDS with the refusal that bounds it, or the bounded caller it is reached through',
    );
  });
  for (const [file, fns] of Object.entries(BOUNDS))
    for (const [name, b] of Object.entries(fns))
      test(`${file}:${name} — ${b.refuses ? `refuses with ${b.expect}` : b.debt ? 'owed by an open finding' : 'bounded by its caller'}`, () => {
        if (b.refuses) assert.equal(b.refuses(), b.expect);
        else if (b.debt) {
          assert.ok(b.bounded.length >= 20, 'say what grows');
          const f = FINDINGS.find((x) => x.id === b.debt);
          assert.equal(f?.status, 'open', `${b.debt} is closed: replace this debt with the bound`);
        } else {
          assert.ok(b.bounded.length >= 20, 'say what bounds it');
          assert.ok(resolves(b.guard), `${b.guard} must resolve`);
        }
      });
  test('the books growing with use is owed by F-105 while it is open', () => {
    assert.equal(BOUNDS['ledger.mjs'].readLedger.debt, 'F-105');
    assert.equal(BOUNDS['ledger.mjs'].totalsOf.debt, 'F-105');
    assert.equal(FINDINGS.find((f) => f.id === 'F-105')?.status, 'open');
  });
  test('a non-string runId, taskId or tokens is refused, not stored whole (F-150)', () => {
    assert.equal(
      code(() =>
        ledger.reserve({
          ledgerPath: fresh(),
          callId: 'c',
          estimatedMaxUsd: 1,
          runId: [long(1e6)],
        }),
      ),
      'INPUT_INVALID',
    );
    assert.equal(
      code(() =>
        ledger.reserve({ ledgerPath: fresh(), callId: 'c', estimatedMaxUsd: 1, taskId: { k: 1 } }),
      ),
      'INPUT_INVALID',
    );
    assert.equal(
      code(() =>
        ledger.reserve({
          ledgerPath: fresh(),
          callId: 'c',
          estimatedMaxUsd: 1,
          runId: long(LIMITS.idChars + 1),
        }),
      ),
      'INPUT_TOO_LONG',
    );
    // tokens: an object over the byte bound, and a non-object, both refused
    const lp = fresh();
    ledger.reserve({ ledgerPath: lp, callId: 'c', estimatedMaxUsd: 1 });
    assert.equal(
      code(() => ledger.settle({ ledgerPath: lp, callId: 'c', actualUsd: 1, tokens: long(1e6) })),
      'INPUT_INVALID',
    );
    assert.equal(
      code(() =>
        ledger.settle({ ledgerPath: lp, callId: 'c', actualUsd: 1, tokens: { blob: long(5000) } }),
      ),
      'INPUT_TOO_LONG',
    );
  });
  test('a huge reconciliation reason is stored truncated, not whole', () => {
    const lp = fresh();
    ledger.markReconciliationRequired({ ledgerPath: lp, reason: long(1e6) });
    const doc = ledger.readLedger({ ledgerPath: lp, maxAgeMs: Number.POSITIVE_INFINITY });
    assert.ok(doc.flags.reason.length <= LIMITS.reasonChars, 'the stored reason is bounded');
  });
  test('max reservable is 0 when the headroom is below the floor', () => {
    const lp = fresh();
    // cap 100, reserve almost all of it: the sliver left is under the floor
    ledger.reserve({
      ledgerPath: lp,
      callId: 'c',
      estimatedMaxUsd: 100 - LIMITS.minEstimateUsd / 2,
    });
    const doc = ledger.readLedger({ ledgerPath: lp, maxAgeMs: Number.POSITIVE_INFINITY });
    const m = ledger.maxReservableUsd(ledger.totalsOf(doc));
    assert.equal(m, 0, 'nothing the floor accepts fits, so report 0');
    // and when room remains, the reported amount is one reserve() actually takes
    const lp2 = fresh();
    const room = ledger.maxReservableUsd(
      ledger.totalsOf(ledger.readLedger({ ledgerPath: lp2, maxAgeMs: Number.POSITIVE_INFINITY })),
    );
    assert.ok(room > 0);
    assert.equal(
      code(() => ledger.reserve({ ledgerPath: lp2, callId: 'c', estimatedMaxUsd: room })),
      'NO_REFUSAL',
    );
  });
  test('defaultLedgerPath reads only the environment', () => {
    const was = process.env.SAKK_LEDGER_PATH;
    try {
      process.env.SAKK_LEDGER_PATH = '/tmp/sakk-env-probe.json';
      assert.equal(ledger.defaultLedgerPath(), '/tmp/sakk-env-probe.json');
    } finally {
      if (was === undefined) delete process.env.SAKK_LEDGER_PATH;
      else process.env.SAKK_LEDGER_PATH = was;
    }
  });
  test('an estimate below the floor is refused (F-105: 1e-300 estimates)', () => {
    assert.equal(
      code(() => ledger.reserve({ ledgerPath: fresh(), callId: 'c', estimatedMaxUsd: 1e-300 })),
      'ESTIMATE_INVALID',
    );
    assert.equal(
      code(() =>
        ledger.reserve({
          ledgerPath: fresh(),
          callId: 'c',
          estimatedMaxUsd: LIMITS.minEstimateUsd,
        }),
      ),
      'NO_REFUSAL',
    );
  });
  test('ids, names and reasons at their limit are accepted, one character over is not', () => {
    assert.equal(
      code(() =>
        ledger.reserve({
          ledgerPath: fresh(),
          callId: long(LIMITS.idChars),
          agentId: long(LIMITS.idChars),
          estimatedMaxUsd: 1,
        }),
      ),
      'NO_REFUSAL',
    );
    assert.equal(
      code(() =>
        ledger.reserve({
          ledgerPath: fresh(),
          callId: 'c',
          agentId: long(LIMITS.idChars + 1),
          estimatedMaxUsd: 1,
        }),
      ),
      'INPUT_TOO_LONG',
    );
    assert.equal(
      code(() =>
        ledger.halt({ ledgerPath: fresh(), by: 'maintainer', reason: long(LIMITS.reasonChars + 1) }),
      ),
      'INPUT_TOO_LONG',
    );
    assert.equal(
      code(() => ledger.halt({ ledgerPath: fresh(), by: 'maintainer', reason: long(LIMITS.reasonChars) })),
      'NO_REFUSAL',
    );
  });
});
