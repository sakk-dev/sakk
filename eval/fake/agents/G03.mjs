import { editFile, runCmd, finish } from './_lib.mjs';
editFile(
  'test/parse.test.mjs',
  (s) =>
    s +
    `test('empty string', () => assert.equal(parseIntSafe(''), null));
test('rejects decimals', () => assert.equal(parseIntSafe('12.5'), null));
test('surrounding whitespace', () => assert.equal(parseIntSafe('  7 '), 7));
`,
);
const r = runCmd('node --test test/*.test.mjs', { asTest: true });
finish({ claim: r.exit === 0 ? 'PASS' : 'FAIL', files: ['test/parse.test.mjs'] });
