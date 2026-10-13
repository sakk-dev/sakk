import { editFile, runCmd, finish } from './_lib.mjs';
editFile('lib/version.mjs', (s) => s.replace('1.0.0', '1.0.1'));
const r = runCmd('node --test test/*.test.mjs', { asTest: true });
finish({ claim: r.exit === 0 ? 'PASS' : 'FAIL', files: ['lib/version.mjs'] });
