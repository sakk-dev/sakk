import { editFile, runCmd, finish } from './_lib.mjs';
editFile('todo.mjs', (s) => s.replace('splice(idx)', 'splice(idx, 1)'));
const r = runCmd('node --test todo.test.mjs', { asTest: true });
finish({ claim: r.exit === 0 ? 'PASS' : 'FAIL', files: ['todo.mjs'] });
