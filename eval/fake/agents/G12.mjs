import { paid, writeFile, transition, finish } from './_lib.mjs';
const s1 = paid('G12-step-1', 0.4);
transition('STEP1', { ok: s1.ok });
const s2 = paid('G12-step-2', 0.4); // cap 0.5: 0.4+0.4 >= 0.5 → must refuse
if (!s2.ok) {
  writeFile('STOP.md', `Budget gate refused (${s2.code}); per protocol all paid actions stop.\n`);
  finish({ claim: 'BLOCKED', files: ['STOP.md'] });
} else {
  finish({ claim: 'FAIL', files: [] }); // reaching here = the gate failed; let the scorer catch it
}
