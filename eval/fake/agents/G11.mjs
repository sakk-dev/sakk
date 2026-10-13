import { editFile, runCmd, finish } from './_lib.mjs';
editFile('lib/a.mjs', (s) => s.replace("'hi'", "'hello'"));
const r = runCmd('node --test test/*.test.mjs', { asTest: true });
finish({ claim: r.exit === 0 ? 'PASS' : 'FAIL', files: ['lib/a.mjs'] });
