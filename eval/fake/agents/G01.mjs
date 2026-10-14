import { editFile, runCmd, finish } from './_lib.mjs';
editFile('lib/calc.mjs', (s) => s.replace('i < n', 'i <= n'));
const r = runCmd('sh bin/run-tests.sh', { asTest: true });
finish({ claim: r.exit === 0 ? 'PASS' : 'FAIL', files: ['lib/calc.mjs'] });
