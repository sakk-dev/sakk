import { writeFile, finish } from './_lib.mjs';
writeFile(
  'SUMMARY.md',
  `# NOTES summary
- Release plan: v2 canary rollout Wednesday, full rollout Friday.
- Risk: payment-callback timeout rate is rising; add monitoring.
- Staffing: Li is on leave next week; the on-call rota is updated.
`,
);
finish({ claim: 'PASS', files: ['SUMMARY.md'] });
