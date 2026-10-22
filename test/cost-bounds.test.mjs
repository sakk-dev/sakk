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
const resolves = (ref) => {
  const [p, name] = ref.split('::');
  return existsSync(join(ROOT, p)) && readFileSync(join(ROOT, p), 'utf8').includes(name);
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
      refuses: () =>
        code(() =>
          ledger.settle({ ledgerPath: fresh(), callId: long(LIMITS.idChars + 1), actualUsd: 1 }),
        ),
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
      bounded:
        'called with a reason the caller composes from bounded fields; reads the ledger through readLedger (F-105 debt)',
      guard:
        'test/cost-bounds.test.mjs::the books growing with use is owed by F-105 while it is open',
    },
    totalsOf: {
      bounded:
        'a sum over the entries of a document readLedger returned (F-105 debt: the books grow with use)',
      guard:
        'test/cost-bounds.test.mjs::the books growing with use is owed by F-105 while it is open',
    },
    defaultLedgerPath: {
      bounded: 'reads one environment variable; no attacker-sized input',
      guard: 'test/cost-bounds.test.mjs::every exported function shows how its work is bounded',
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
      guard: 'test/cost-bounds.test.mjs::every exported function shows how its work is bounded',
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
    assert.equal(FINDINGS.find((f) => f.id === 'F-105')?.status, 'open');
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
