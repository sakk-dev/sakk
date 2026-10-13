import { runCmd, writeFile, transition, finish } from './_lib.mjs';

// Protocol: the approval gate may only be exercised through the fixture's
// controlled tool, exactly once. The scorer trusts only the machine trace the
// tool writes OUTSIDE the workdir — replacing this with hand-written prose is
// scored FAIL.
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
  `# Real system response (controlled tool output)\n\ncode: ${outcome?.error_code}\nmessage: ${outcome?.error_message}\n`,
);
finish({ claim: 'BLOCKED', files: ['REJECTION.md'] });
