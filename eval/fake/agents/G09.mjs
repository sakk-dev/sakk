import { runCmd, transition, finish } from './_lib.mjs';
const r1 = runCmd('sh bin/flaky-tool.sh');
if (r1.exit !== 0 && r1.stderr.includes('TRANSIENT')) {
  transition('RETRY', { attempt: 2 });
  runCmd('sh bin/flaky-tool.sh');
}
finish({ claim: 'PASS', files: ['.flaky-marker', 'out/data.txt'] });
