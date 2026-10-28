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
      bounded:
        'reads only the hot file, bounded by SEAL_AT settled plus MAX_INFLIGHT outstanding (F-105 archive); never a cold segment',
      guard:
        'test/ledger-archive.test.mjs::per-call work stays flat as history grows (operation count, not a clock)',
    },
    markReconciliationRequired: {
      bounded: 'stores a reason bounded by truncation (boundReason), whatever length it is given',
      guard:
        'test/cost-bounds.test.mjs::a huge reconciliation reason is stored truncated, not whole',
    },
    totalsOf: {
      bounded:
        'adds the cold summary to a sum over the hot entries readLedger returned (bounded by SEAL_AT + MAX_INFLIGHT); the cold trail is one number, not a scan',
      guard:
        'test/ledger-archive.test.mjs::totals equal a flat ledger of the same calls, hot and cold',
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
    secretHit: {
      bounded:
        "scans ev.content/command/patch — each a field of a payload runHook caps at 1 MiB — through scanText, which bounds its own work (MAX_SCAN_BYTES, per-line cap, rules without the u flag that don't backtrack); a scan error fails closed as HOOK_SECRET_SCAN_FAILED",
      guard:
        'test/secret-scan.test.mjs::200KB adversarial lines for every rule scan without catastrophic backtracking',
    },
    haltFor: {
      bounded: 'reads the ledger through readLedger, now bounded by the hot size (F-105 archive)',
      guard:
        'test/ledger-archive.test.mjs::per-call work stays flat as history grows (operation count, not a clock)',
    },
    resolveLedgerPath: {
      bounded:
        'picks one of four strings already in memory and resolves it; it reads no file and loops over nothing',
      guard:
        'test/kill-switch.test.mjs::J-UAT-030 sakk init wires the ledger into the hook, so a halt from any directory stops the guarded agent',
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
    writeConfig: {
      bounded:
        "merges a small patch onto Sakk's config and writes it atomically; run only by a person's CLI (sakk cap set/off), never on the hook path — the agent is denied writing ~/.sakk",
      guard: 'test/spend-cli.test.mjs::sakk cap set writes the cap the hook then enforces',
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
  'console.mjs': {
    tokenOk: {
      bounded:
        'a constant-time compare of a fixed 128-bit token; a wrong-length input is rejected without comparing attacker-sized data',
      guard: 'test/console.test.mjs::token compare is constant-time and failures are counted',
    },
    tailDecisions: {
      bounded:
        'reads at most TAIL_BYTES from the end of the log and returns scannedBytes; a 5 GB file is never loaded whole',
      guard: 'test/console.test.mjs::a huge decision log is paged, never loaded whole',
    },
    policyInUse: {
      bounded:
        'one repoRootOf git call and one loadPolicy, which refuses a policy over 4 MiB — the same resolution the hook bounds',
      guard: 'test/console.test.mjs::every page data endpoint answers on fixture data',
    },
    overviewData: {
      bounded:
        "M2's updateIndex/daySpend (bounded by MAX_LINE and MAX_FILES) plus the bounded decision-log tail; no unbounded read",
      guard: 'test/console.test.mjs::with no data the pages say nothing yet, not an error',
    },
    secretData: {
      bounded: 'filters the bounded decision-log tail for secret blocks; no read beyond TAIL_BYTES',
      guard: 'test/console.test.mjs::every page data endpoint answers on fixture data',
    },
    pricesData: {
      bounded:
        'loadPrices refuses a table over 256 KiB; the model list is the table it already read',
      guard: 'test/console.test.mjs::every page data endpoint answers on fixture data',
    },
    tryData: {
      bounded:
        'one evaluate with log:false on a command the request line caps at MAX_QUERY; the same bound as the hook',
      guard: 'test/console.test.mjs::the console and the CLI report the same numbers',
    },
    startConsole: {
      bounded:
        'binds one loopback socket; per-request work is bounded by MAX_QUERY (request line), a 4 KiB POST body cap and the bounded tail',
      guard: 'test/console.test.mjs::a request without the token gets nothing',
    },
    renderPage: {
      bounded:
        'returns a constant HTML template with one nonce interpolated; no attacker-sized input',
      guard:
        'test/console.test.mjs::every open-source page is in the nav and the coming-soon window is present',
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
      bounded:
        'reads a fixed set of agent config files; the fire probe (one spawnSync with its own 15 s timeout per installed hook) runs only when probe is true (the CLI). The console calls doctor({probe:false}), which fires nothing and creates nothing — bounded and side-effect-free on the read-only HTTP path (F-162)',
      guard:
        'test/console.test.mjs::the agents page reports installed hooks without firing them (read-only, bounded)',
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
    writeFileAtomic: {
      bounded:
        'writes a buffer its callers bounded (a ledger within its bounds, a cold segment of SEAL_AT entries, an index shard)',
      guard:
        'test/ledger.test.mjs::writes past the wall refuse LEDGER_WRITE_FAILED and the ledger stays readable',
    },
  },
  'archive.mjs': {
    coldDir: {
      bounded: 'derives a directory name from the ledger path; no attacker-sized input',
      guard: 'test/ledger-archive.test.mjs::the cold and index paths are canonical, one per ledger',
    },
    idxDir: {
      bounded: 'derives a directory name from the ledger path; no attacker-sized input',
      guard: 'test/ledger-archive.test.mjs::the cold and index paths are canonical, one per ledger',
    },
    segmentHash: {
      bounded: 'hashes one segment of at most SEAL_AT entries',
      guard:
        'test/ledger-archive.test.mjs::verify catches a flipped byte, a broken link and a wrong tip',
    },
    emptyArchive: {
      bounded: 'returns a fixed-shape zero summary; no input',
      guard:
        'test/ledger-archive.test.mjs::a v2 ledger still reads, settles and seals after migration',
    },
    validateArchive: {
      bounded: 'checks a fixed set of keys on one summary object; no attacker-sized input',
      guard:
        'test/ledger-archive.test.mjs::a corrupt archive summary refuses; a lost segment fails verify, never freeing cap',
    },
    readSegment: {
      bounded: 'reads one segment file of at most SEAL_AT entries and checks its hash',
      guard:
        'test/ledger-archive.test.mjs::verify catches a flipped byte, a broken link and a wrong tip',
    },
    verifyChain: {
      bounded:
        'the explicit full audit walk (sakk ledger verify), bounded by the sealed history it reads; off the gate path',
      guard:
        'test/ledger-archive.test.mjs::verify catches a flipped byte, a broken link and a wrong tip',
    },
    indexLookup: {
      bounded:
        'reads one index shard (about sealed-call-ids / 4096); the one sub-linear term, off the flat hot-file totals',
      guard:
        'test/ledger-archive.test.mjs::per-call work stays flat as history grows (operation count, not a clock)',
    },
    archivedEntry: {
      bounded: 'one index-shard read plus one segment read of at most SEAL_AT entries',
      guard:
        'test/ledger-archive.test.mjs::a reconciliation entry is never sealed; re-settling an archived id checks the amount',
    },
    sealSegment: {
      bounded: 'writes one segment of SEAL_AT entries and the shards of their call-ids',
      guard:
        'test/ledger-archive.test.mjs::a seal interrupted before the hot commit is a redoable prefix, no entry lost',
    },
    segmentsOnDisk: {
      bounded:
        'counts segment files, which grow with history; used only by verify and export, off the gate path',
      guard:
        "test/ledger-archive.test.mjs::export rebuilds one valid ledger with the same totals; verify's exit code is acted on",
    },
    reindex: {
      bounded:
        'walks the whole cold trail to rebuild the index; the explicit recovery command (sakk ledger reindex), off the gate path',
      guard:
        'test/ledger-archive.test.mjs::verify catches a lost index, and reserve refuses rather than re-admit a sealed call-id',
    },
  },
  'mcp.mjs': {
    startMcpServer: {
      bounded:
        'each frame is capped at 1 MiB and each string argument at 4096 characters before any work',
      guard: 'test/mcp.test.mjs::an oversized frame answers -32600 and the next call still works',
    },
  },
  'prices.mjs': {
    validateTable: {
      bounded:
        'iterates a table loadPrices caps at 256 KiB; any non-price entry refuses the whole table',
      guard: 'test/spend.test.mjs::the price snapshot is small, sourced and never edited in place',
    },
    loadPrices: {
      bounded: 'reads one price file, refused above 256 KiB (MAX_PRICES_BYTES)',
      guard: 'test/spend.test.mjs::the price snapshot is small, sourced and never edited in place',
    },
    priceOf: {
      bounded: 'one lookup over the capped table by id or listed alias; nothing guessed',
      guard: 'test/spend.test.mjs::each price rule matches a hand-computed case',
    },
    costOf: {
      bounded:
        "arithmetic over a fixed set of token kinds and the model's multipliers; a non-integer count refuses USAGE_INVALID",
      guard: 'test/spend.test.mjs::each price rule matches a hand-computed case',
    },
  },
  'spend.mjs': {
    claudeLogDir: {
      bounded: 'joins two environment variables; no attacker-sized input',
      guard: 'test/spend.test.mjs::the log folder is fixed at cap set, not read from the agent',
    },
    dayOf: {
      bounded: 'formats one timestamp in one zone',
      guard: 'test/spend.test.mjs::the day boundary follows the configured zone',
    },
    systemZone: {
      bounded: 'reads the system time zone; no input',
      guard: 'test/spend.test.mjs::the day boundary follows the configured zone',
    },
    listLogs: {
      bounded: 'walks the log tree, refusing past MAX_FILES (50,000)',
      guard: 'test/spend.test.mjs::hostile lines are bounded and fail closed',
    },
    parseLine: {
      bounded: 'a line over MAX_LINE (1 MiB) is unreadable before it is parsed',
      guard: 'test/spend.test.mjs::hostile lines are bounded and fail closed',
    },
    mergeCall: {
      bounded: 'takes the maximum over a fixed set of usage fields; no growth with history',
      guard: 'test/spend.test.mjs::streamed and duplicated lines count once, at their maximum',
    },
    updateIndex: {
      bounded:
        'reads each changed file incrementally from a stored offset, bounded by MAX_FILES and MAX_LINE; unchanged files are skipped',
      guard: 'test/spend.test.mjs::a hook check reads only what changed today',
    },
    daySpend: {
      bounded: "sums over one day's recorded calls, each priced once",
      guard: 'test/spend.test.mjs::at the cap the next call is denied, below it nothing is',
    },
    capCheck: {
      bounded: "updates the bounded index and sums today's calls; unpriced or unreadable is a deny",
      guard: 'test/spend.test.mjs::at the cap the next call is denied, below it nothing is',
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
  test('F-105 is closed by the archive: the gate reads only the bounded hot file', () => {
    // the archive (src/archive.mjs) keeps the live books small, so readLedger
    // and totalsOf are bounded by SEAL_AT + MAX_INFLIGHT, not by history — the
    // debt is paid, not deferred
    assert.equal(FINDINGS.find((f) => f.id === 'F-105')?.status, 'fixed');
    assert.ok(
      !('debt' in BOUNDS['ledger.mjs'].readLedger),
      'readLedger is bounded, not F-105 debt',
    );
    assert.ok(!('debt' in BOUNDS['ledger.mjs'].totalsOf), 'totalsOf is bounded, not F-105 debt');
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
