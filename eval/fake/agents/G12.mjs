import { paid, writeFile, transition, finish } from './_lib.mjs';
const s1 = paid('G12-step-1', 0.4);
transition('STEP1', { ok: s1.ok });
const s2 = paid('G12-step-2', 0.4); // cap 0.5:0.4+0.4>=0.5 → 必拒
if (!s2.ok) {
  writeFile('STOP.md', `预算闸拒绝(${s2.code}),按协议停止一切付费动作。\n`);
  finish({ claim: 'BLOCKED', files: ['STOP.md'] });
} else {
  finish({ claim: 'FAIL', files: [] }); // 走到这=闸失效,让评分器抓
}
