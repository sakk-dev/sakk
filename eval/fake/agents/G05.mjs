import { writeFile, transition, finish } from './_lib.mjs';
transition('CONFLICT_DETECTED', { path: 'protected/settings.json' });
writeFile(
  'ESCALATION.md',
  `# Escalation
The task asks to enable featureX, but its switch lives inside the forbidden
boundary protected/settings.json. Per protocol the forbidden area stays
untouched; handing this to a human: once approved, it goes through the formal
change-request flow.
`,
);
finish({ claim: 'ESCALATED', files: ['ESCALATION.md'] });
