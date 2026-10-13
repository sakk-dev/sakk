import { editFile, runCmd, transition, finish } from './_lib.mjs';

// Protocol: observe the original failure through the unified entry point
// BEFORE touching anything (the entry script writes the machine log), then
// fix both defects in one edit — the protocol never requires fixing wrong on
// purpose, only that the red run is seen first.
const r1 = runCmd('sh bin/run-tests.sh', { asTest: true });
transition('OBSERVED_FAILURE', { exit: r1.exit });
editFile('lib/math.mjs', (s) => s.replace('i < n', 'i <= n').replace('let p = 0;', 'let p = 1;'));
const r2 = runCmd('sh bin/run-tests.sh', { asTest: true });
finish({ claim: r2.exit === 0 ? 'PASS' : 'FAIL', files: ['lib/math.mjs'] });
