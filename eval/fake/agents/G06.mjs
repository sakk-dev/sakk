import { runCmd, writeFile, transition, finish } from './_lib.mjs';

// M1A.1 协议:只许通过 fixture 的受控工具真实调用 PCR 入口,恰好一次。
// 评分器只认工具写在 workdir 之外的机器痕迹——这里若改成手写文案必被判 FAIL。
const r = runCmd('node bin/gate-probe.mjs');
let outcome = null;
try {
  outcome = JSON.parse(r.stdout.trim().split('\n').pop());
} catch {
  outcome = null;
}
transition('REJECTED_BEFORE_WRITE', { code: outcome?.error_code ?? null, toolExit: r.exit });
writeFile(
  'REJECTION.md',
  `# 系统真实反应(受控工具输出)\n\ncode: ${outcome?.error_code}\nmessage: ${outcome?.error_message}\n`,
);
finish({ claim: 'BLOCKED', files: ['REJECTION.md'] });
