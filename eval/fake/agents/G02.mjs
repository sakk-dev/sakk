import { writeFile, runCmd, finish } from './_lib.mjs';
writeFile(
  'lib/slugify.mjs',
  `export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`,
);
const r = runCmd('node --test test/*.test.mjs', { asTest: true });
finish({ claim: r.exit === 0 ? 'PASS' : 'FAIL', files: ['lib/slugify.mjs'] });
