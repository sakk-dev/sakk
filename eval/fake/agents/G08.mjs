import { editFile, runCmd, transition, finish } from './_lib.mjs';

// M1A.1 协议:动手之前先用统一入口观察原始失败(机器日志由入口脚本落盘),
// 然后一次修对两处缺陷——协议不要求故意修错一次,只要求「先看见红」。
const r1 = runCmd('sh bin/run-tests.sh', { asTest: true });
transition('OBSERVED_FAILURE', { exit: r1.exit });
editFile('lib/math.mjs', (s) => s.replace('i < n', 'i <= n').replace('let p = 0;', 'let p = 1;'));
const r2 = runCmd('sh bin/run-tests.sh', { asTest: true });
finish({ claim: r2.exit === 0 ? 'PASS' : 'FAIL', files: ['lib/math.mjs'] });
